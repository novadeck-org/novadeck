import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import type { UpdateOffer } from "../model/update"
import { context, describe, expect, it } from "../test"
import { render, type Rendered } from "../test/render"
import { recoveredForMs, WorkspaceFooter, type FooterStatus } from "./WorkspaceFooter"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
})

const props = (status: FooterStatus, update?: UpdateOffer, onInstall = () => {}) => ({
  hidden: false,
  count: 2,
  running: 1,
  status,
  update: update && {
    offer: update,
    open: false,
    blocked: false,
    returnFocus: () => false,
    onOpenChange: () => {},
    onShown: () => {},
    onInstall,
    onOpenPage: () => {},
  },
})

const ready: UpdateOffer = { kind: "ready", version: "0.0.80", notes: [] }

const announcer = (page: Rendered) =>
  page.container.querySelector<HTMLElement>(".sr-only[role=status]")!

const footer = (status: FooterStatus) =>
  createElement(WorkspaceFooter, { hidden: false, count: 2, running: 1, status })

const show = (status: FooterStatus) => {
  const page = render(footer(status))
  mounted.push(page)
  const bar = () => page.container.querySelector("footer")!
  return {
    bar,
    said: () => page.container.querySelector(".footer-status [role=status]")?.textContent ?? "",
    change: (next: FooterStatus) => page.rerender(footer(next)),
  }
}

const added = (html: string): Element => {
  const holder = document.createElement("div")
  holder.innerHTML = html
  document.body.append(holder)
  return holder
}

const notice = (page: Rendered) => page.container.querySelector("section.update-panel")

const chip = (page: Rendered) => page.container.querySelector<HTMLButtonElement>(".footer-update")!

describe("workspace footer", () => {
  context("while the runner link is healthy", () => {
    it("shows the counts untoned and no status", () => {
      const { bar, said } = show("ok")
      expect(bar().textContent).toContain("2 terminals")
      expect(bar().hasAttribute("data-tone")).toBe(false)
      expect(said()).toBe("")
    })
  })

  context("while the runner reconnects", () => {
    it("tones the whole bar as a warning and says so", () => {
      const { bar, said } = show("reconnecting")
      expect(bar().dataset["tone"]).toBe("warning")
      expect(bar().textContent).toContain("1 running")
      expect(said()).toBe("Reconnecting")
    })
  })

  context("when the runner is unavailable", () => {
    it("tones the bar as danger and says so assertively", () => {
      const { bar, said } = show("unavailable")
      expect(bar().dataset["tone"]).toBe("danger")
      expect(said()).toBe("Offline")
      expect(bar().querySelector(".footer-status [role=status]")?.getAttribute("aria-live")).toBe(
        "assertive",
      )
    })
  })

  context("when the runner keeps restarting", () => {
    it("tones the bar as danger and says so", () => {
      const { bar, said } = show("restarting")
      expect(bar().dataset["tone"]).toBe("danger")
      expect(said()).toBe("Crash loop")
    })
  })

  context("while a crash loop offers to try again", () => {
    it("carries a Try again action that starts over", () => {
      const onRetry = vi.fn<() => void>()
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 2,
          running: 0,
          status: "restarting",
          onRetry,
        }),
      )
      mounted.push(page)
      const action = [...page.container.querySelectorAll("button")].find(
        (button) => button.textContent === "Try again",
      )!
      act(() => action.click())
      expect(onRetry).toHaveBeenCalledOnce()
    })

    it("offers nothing while the runner only reconnects", () => {
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 2,
          running: 0,
          status: "reconnecting",
          onRetry: () => {},
        }),
      )
      mounted.push(page)
      expect(page.container.querySelector("button")).toBeNull()
    })
  })

  context("once the runner is back", () => {
    it("tones the bar as success with Reconnected for a moment, then rests untoned", () => {
      vi.useFakeTimers()
      const { bar, said, change } = show("reconnecting")
      change("ok")
      expect(bar().dataset["tone"]).toBe("success")
      expect(said()).toBe("Reconnected")
      act(() => vi.advanceTimersByTime(recoveredForMs))
      expect(bar().hasAttribute("data-tone")).toBe(false)
      expect(said()).toBe("")
    })
  })

  context("while an update waits", () => {
    const withUpdate = (status: FooterStatus, update: UpdateOffer = ready) => {
      const page = render(createElement(WorkspaceFooter, props(status, update)))
      mounted.push(page)
      return page
    }
    it("keeps a polite live region mounted, empty until the update arrives, then fills it", () => {
      const page = render(createElement(WorkspaceFooter, props("ok")))
      mounted.push(page)
      const region = announcer(page)
      expect(region.getAttribute("aria-live")).toBe("polite")
      expect(region.textContent).toBe("")
      page.rerender(createElement(WorkspaceFooter, props("ok", ready)))
      expect(announcer(page)).toBe(region)
      expect(region.textContent).toBe("Update ready")
    })

    it("says what is ready or available on the chip, and the narrow bar shows Update alone", () => {
      const page = withUpdate("ok")
      expect(chip(page).getAttribute("aria-label")).toBe("Update ready: Novadeck 0.0.80")
      expect(chip(page).textContent).toBe("Update readyUpdate")
      const narrow = chip(page).querySelector(".hidden")!
      expect(narrow.textContent).toBe("Update")
      page.rerender(createElement(WorkspaceFooter, props("ok", { ...ready, kind: "available" })))
      expect(announcer(page).textContent).toBe("Update available")
      expect(chip(page).getAttribute("aria-label")).toBe("Update available: Novadeck 0.0.80")
    })

    it("leaves the bar's tone and the link's status to the connection", () => {
      const page = withUpdate("unavailable")
      const bar = page.container.querySelector("footer")!
      expect(bar.dataset["tone"]).toBe("danger")
      expect(bar.textContent).toContain("Offline")
      expect(bar.textContent).toContain("Update ready")
      expect(bar.querySelector(".footer-status [role=status]")?.textContent).toBe("Offline")
    })

    context("whose notice is raised", () => {
      const raised = (
        { hidden = false, blocked = false } = {},
        onShown = (_key: string) => {},
        offer: UpdateOffer = ready,
      ) =>
        createElement(WorkspaceFooter, {
          ...props("ok"),
          hidden,
          update: {
            offer,
            open: true,
            blocked,
            returnFocus: () => false,
            onOpenChange: () => {},
            onShown,
            onInstall: () => {},
            onOpenPage: () => {},
          },
        })

      it("is not shown while the footer is hidden, and is with the footer", () => {
        const onShown = vi.fn<(key: string) => void>()
        const page = render(raised({ hidden: true }, onShown))
        mounted.push(page)
        expect(notice(page)).toBeNull()
        expect(onShown).not.toHaveBeenCalled()
        page.rerender(raised({}, onShown))
        expect(notice(page)).not.toBeNull()
        expect(onShown).toHaveBeenCalledExactlyOnceWith("ready:0.0.80")
      })

      it("is not shown, nor marked shown, while a dialog is open", () => {
        const onShown = vi.fn<(key: string) => void>()
        const page = render(raised({ blocked: true }, onShown))
        mounted.push(page)
        expect(notice(page)).toBeNull()
        expect(onShown).not.toHaveBeenCalled()
        page.rerender(raised({}, onShown))
        expect(notice(page)).not.toBeNull()
        expect(onShown).toHaveBeenCalledOnce()
      })

      it("is a labelled region of the footer, not a dialog, taking no focus", () => {
        const page = render(raised())
        mounted.push(page)
        const region = notice(page)!
        expect(region.getAttribute("role")).toBeNull()
        expect(document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe(
          "Novadeck 0.0.80 is ready",
        )
        expect(region.closest("footer")).not.toBeNull()
        expect(region.contains(document.activeElement)).toBe(false)
      })

      context("with a menu or a hover card already in the page", () => {
        it("does not show, nor count as shown, until the menu is gone", () => {
          vi.useFakeTimers()
          const menu = added('<div role="menu"></div>')
          const onShown = vi.fn<(key: string) => void>()
          const page = render(raised({}, onShown))
          mounted.push(page)
          expect(notice(page)).toBeNull()
          expect(onShown).not.toHaveBeenCalled()
          menu.remove()
          act(() => vi.advanceTimersByTime(200))
          expect(notice(page)).not.toBeNull()
          expect(onShown).toHaveBeenCalledOnce()
        })

        it("shows through a hover card, which asks for nothing", () => {
          const card = added('<div role="dialog" class="floating peek"></div>')
          const page = render(raised())
          mounted.push(page)
          expect(notice(page)).not.toBeNull()
          card.remove()
        })
      })

      it("puts focus on the chip when closed from the keyboard with no terminal to return to", () => {
        const page = render(raised())
        mounted.push(page)
        const later = [...page.container.querySelectorAll("section button")].find(
          (button) => button.textContent === "Later",
        ) as HTMLButtonElement
        later.focus()
        act(() => later.click())
        expect(document.activeElement).toBe(chip(page))
      })

      it("stops showing Restarting once the offer turns into one to download, or back", () => {
        const page = render(raised())
        mounted.push(page)
        const restart = [...page.container.querySelectorAll("section button")].find(
          (button) => button.textContent === "Restart now",
        ) as HTMLButtonElement
        act(() => restart.click())
        expect(chip(page).textContent).toBe("Restarting…")
        page.rerender(raised({}, undefined, { ...ready, kind: "available" }))
        expect(chip(page).textContent).toBe("Update availableUpdate")
        page.rerender(raised())
        expect(chip(page).textContent).toBe("Update readyUpdate")
      })

      it("shows five notes and says how many more there are, outside the list", () => {
        const notes = Array.from({ length: 8 }, (_, index) => `Note ${index + 1}`)
        const page = render(raised({}, undefined, { ...ready, notes }))
        mounted.push(page)
        expect(page.container.querySelectorAll(".update-notes li")).toHaveLength(5)
        expect(page.container.querySelector(".update-more")?.textContent).toBe("and 3 more")
        expect(page.container.querySelector(".update-more")?.closest("li")).toBeNull()
      })
    })

    it("shows nothing without an update", () => {
      const page = render(
        createElement(WorkspaceFooter, { hidden: false, count: 2, running: 1, status: "ok" }),
      )
      mounted.push(page)
      expect(page.container.querySelector("button")).toBeNull()
      expect(page.container.textContent).not.toContain("Update")
    })
  })
})

const sandboxLabel = "No sandbox: Novadeck is running without its security sandbox"
const sandboxChip = (page: Rendered) =>
  [...page.container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === sandboxLabel,
  )
const panel = (page: Rendered) => page.container.querySelector("section.sandbox-panel")

describe("the footer without the security sandbox", () => {
  const sandbox = ({
    fix = "sudo fix",
    open = false,
    blocked = false,
    hidden = false,
    onOpenChange = (_open: boolean) => {},
  } = {}) =>
    createElement(WorkspaceFooter, {
      ...props("ok"),
      hidden,
      sandbox: { fix, open, blocked, onOpenChange },
    })
  const mount = (options: Parameters<typeof sandbox>[0] = {}) => {
    const page = render(sandbox(options))
    mounted.push(page)
    return page
  }

  it("shows nothing where the app is sandboxed or the host does not say", () => {
    const page = render(createElement(WorkspaceFooter, props("ok")))
    mounted.push(page)
    expect(sandboxChip(page)).toBeUndefined()
    expect(panel(page)).toBeNull()
  })

  it("shows a closed chip, saying No sandbox at every width, that asks to open", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>()
    const page = mount({ onOpenChange })
    const button = sandboxChip(page)!
    expect(button.textContent).toBe("No sandbox")
    expect(button.getAttribute("aria-label")!.startsWith(button.textContent)).toBe(true)
    expect(button.getAttribute("aria-expanded")).toBe("false")
    expect(panel(page)).toBeNull()
    act(() => button.click())
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true)
  })

  it("opens a region saying why and what to run, with the command", () => {
    const page = mount({ open: true })
    const region = panel(page)!
    expect(sandboxChip(page)!.getAttribute("aria-expanded")).toBe("true")
    expect(document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Novadeck is running without its security sandbox",
    )
    expect(region.textContent).toContain(
      "This system blocks the sandbox. Run this command, then quit Novadeck and start it again from your applications menu.",
    )
    expect(region.querySelector("code")?.textContent).toBe("sudo fix")
  })

  it("is not marked as the update's notice, whose focus handling keys on its class", () => {
    const page = mount({ open: true })
    expect(page.container.querySelector(".update-panel")).toBeNull()
  })

  it("says it was started without, blocking nothing, and has no command or button without a fix", () => {
    const page = mount({ fix: "", open: true })
    const region = panel(page)!
    expect(region.textContent).toContain("Started with --no-sandbox, or this system")
    expect(region.textContent).not.toContain("blocks")
    expect(region.querySelector("code")).toBeNull()
    expect(region.querySelector("button")).toBeNull()
  })

  it("copies the command, says so for a moment, and keeps focus on its button", async () => {
    vi.useFakeTimers()
    const writeText = vi.fn<(text: string) => Promise<void>>(() => Promise.resolve())
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    try {
      const page = mount({ open: true })
      const copy = panel(page)!.querySelector("button")!
      expect(copy.textContent).toBe("Copy")
      await act(async () => copy.click())
      expect(writeText).toHaveBeenCalledExactlyOnceWith("sudo fix")
      expect(copy.textContent).toBe("Copied")
      expect(document.activeElement).toBe(copy)
      act(() => vi.advanceTimersByTime(2_000))
      expect(copy.textContent).toBe("Copy")
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it("asks to close on Escape", () => {
    const onOpenChange = vi.fn<(open: boolean) => void>()
    const page = mount({ open: true, onOpenChange })
    act(() =>
      panel(page)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    )
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false)
  })

  it("waits while the footer is hidden or a dialog asks, and while a menu is open", () => {
    expect(panel(mount({ open: true, hidden: true }))).toBeNull()
    expect(panel(mount({ open: true, blocked: true }))).toBeNull()
    const menu = document.createElement("div")
    menu.setAttribute("role", "menu")
    document.body.append(menu)
    try {
      expect(panel(mount({ open: true }))).toBeNull()
    } finally {
      menu.remove()
    }
  })
})
