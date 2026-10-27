import type { PortableInstall } from "@novadeck/core/portable"
import type { UpdateOffer, WhatsNew } from "@novadeck/core/update"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { fadeMs, finishedForMs } from "./linger"
import type { FooterPortable } from "./PortableInstall"
import { UpdateProgress } from "./UpdateProgress"
import { recoveredForMs, WorkspaceFooter, type FooterStatus } from "./WorkspaceFooter"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  vi.useRealTimers()
  localStorage.clear()
})

const portable = {
  unsandboxed: false,
  onInstall: () => {},
  install: { phase: "idle" } as PortableInstall,
}

// A portable copy's install entry; a copy that updates itself has none.
const props = (status: FooterStatus, update?: UpdateOffer) => ({
  hidden: false,
  count: 2,
  running: 1,
  status,
  portable: {
    offer: update,
    portable,
    open: false,
    blocked: false,
    returnFocus: () => false,
    onOpenChange: () => {},
    onShown: () => {},
  },
})

const ready: UpdateOffer = { kind: "ready", version: "0.0.80" }
const downloading: UpdateOffer = { ...ready, kind: "downloading", percent: 42 }

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

const notice = (page: Rendered) => page.container.querySelector("section.portable-card")

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

  context("with agents that wait on something they started", () => {
    it("counts them apart from the running, and says nothing without any", () => {
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 3,
          running: 3,
          waiting: 2,
          status: "ok",
        }),
      )
      mounted.push(page)
      const text = page.container.querySelector("footer")!.textContent
      expect(text).toContain("3 running")
      expect(text).toContain("2 waiting")
      expect(show("ok").bar().textContent).not.toContain("waiting")
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

  context("while an update downloads", () => {
    const withProgress = (offer: UpdateOffer | null, hidden = false, noticeOpen = false) =>
      createElement(WorkspaceFooter, {
        hidden,
        count: 2,
        running: 1,
        status: "ok",
        progress: offer,
        noticeOpen,
      })
    const bar = (page: Rendered) => page.container.querySelector(".update-progress")
    // The last of the bar's live regions, the progress bar's after the portable entry's.
    const progressAnnouncer = (page: Rendered) =>
      [...page.container.querySelectorAll<HTMLElement>(".sr-only[role=status]")].at(-1)!

    it("floats a bar with the percent and the version, nothing to press", () => {
      const page = render(withProgress(downloading))
      mounted.push(page)
      expect(bar(page)?.textContent).toContain("Updating Novadeck")
      expect(bar(page)?.textContent).toContain("42%")
      expect(bar(page)?.textContent).toContain("Downloading 0.0.80")
      expect(bar(page)?.getAttribute("aria-hidden")).toBe("true")
      expect(bar(page)?.querySelector("button")).toBeNull()
      expect(page.container.querySelector("footer button")).toBeNull()
    })

    it("announces that it started and, once, that it finished, not each percent", () => {
      const page = render(withProgress(null))
      mounted.push(page)
      const region = progressAnnouncer(page)
      expect(region.getAttribute("aria-live")).toBe("polite")
      expect(region.textContent).toBe("")
      page.rerender(withProgress(downloading))
      expect(region.textContent).toBe("Downloading Novadeck update")
      page.rerender(withProgress({ ...downloading, percent: 43 }))
      expect(region.textContent).toBe("Downloading Novadeck update")
      page.rerender(withProgress(ready))
      expect(region.textContent).toBe("Novadeck update downloaded, installs on the next restart")
    })

    it("says it installs on the next restart for a while, fades, then goes", () => {
      vi.useFakeTimers()
      const page = render(withProgress(downloading))
      mounted.push(page)
      page.rerender(withProgress(ready))
      expect(bar(page)?.textContent).toContain("Update ready")
      expect(bar(page)?.textContent).toContain("100%")
      expect(bar(page)?.textContent).toContain("0.0.80 installs on the next restart")
      act(() => vi.advanceTimersByTime(finishedForMs - 1))
      expect(bar(page)?.getAttribute("data-state")).toBe("open")
      act(() => vi.advanceTimersByTime(1))
      expect(bar(page)?.getAttribute("data-state")).toBe("closed")
      act(() => vi.advanceTimersByTime(fadeMs))
      expect(bar(page)).toBeNull()
      expect(progressAnnouncer(page).textContent).toBe("")
    })

    it("says on macOS that it installs when the person quits, where closing doesn't", () => {
      const mac = (offer: UpdateOffer | null) =>
        createElement(UpdateProgress, { offer, hidden: false, platform: "mac" })
      const page = render(mac(downloading))
      mounted.push(page)
      page.rerender(mac(ready))
      expect(bar(page)?.textContent).toContain("0.0.80 installs when you quit Novadeck")
      expect(page.container.querySelector<HTMLElement>(".sr-only[role=status]")?.textContent).toBe(
        "Novadeck update downloaded, installs when you quit Novadeck",
      )
    })

    it("shows nothing for an update found ready, as at a launch, or one to fetch", () => {
      const page = render(withProgress(ready))
      mounted.push(page)
      expect(bar(page)).toBeNull()
      page.rerender(withProgress({ ...ready, kind: "available" }))
      expect(bar(page)).toBeNull()
    })

    it("drops at once when the download fails", () => {
      const page = render(withProgress(downloading))
      mounted.push(page)
      page.rerender(withProgress({ ...ready, kind: "available" }))
      expect(bar(page)).toBeNull()
    })

    it("is not shown while the footer is hidden", () => {
      const page = render(withProgress(downloading, true))
      mounted.push(page)
      expect(bar(page)).toBeNull()
      page.rerender(withProgress(downloading))
      expect(bar(page)).not.toBeNull()
    })

    it("gives way to a notice open in its corner, and returns when it closes", () => {
      const page = render(withProgress(downloading, false, true))
      mounted.push(page)
      expect(bar(page)).toBeNull()
      page.rerender(withProgress(downloading))
      expect(bar(page)).not.toBeNull()
    })

    it("spends the finished bar's time in view, so one finishing in Zen mode is seen", () => {
      vi.useFakeTimers()
      const page = render(withProgress(downloading))
      mounted.push(page)
      page.rerender(withProgress(ready, true))
      act(() => vi.advanceTimersByTime(finishedForMs + fadeMs + 1_000))
      page.rerender(withProgress(ready))
      expect(bar(page)?.getAttribute("data-state")).toBe("open")
      expect(bar(page)?.textContent).toContain("Update ready")
      act(() => vi.advanceTimersByTime(finishedForMs))
      expect(bar(page)?.getAttribute("data-state")).toBe("closed")
      act(() => vi.advanceTimersByTime(fadeMs))
      expect(bar(page)).toBeNull()
    })

    it("leaves the bar's tone and the link's status to the connection", () => {
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: false,
          count: 2,
          running: 1,
          status: "unavailable",
          progress: downloading,
        }),
      )
      mounted.push(page)
      const frame = page.container.querySelector("footer")!
      expect(frame.dataset["tone"]).toBe("danger")
      expect(frame.querySelector(".footer-status [role=status]")?.textContent).toBe("Offline")
    })
  })

  context("for a release an installed copy can't install itself", () => {
    const withChip = (available?: {
      version: string
      onOpenPage: () => void
      onAllow?: () => void
    }) =>
      createElement(WorkspaceFooter, {
        hidden: false,
        count: 2,
        running: 1,
        status: "ok",
        available,
      })
    const button = (page: Rendered) =>
      page.container.querySelector<HTMLButtonElement>("footer button")

    it("shows nothing without one", () => {
      const page = render(withChip())
      mounted.push(page)
      expect(button(page)).toBeNull()
    })

    it("is a quiet chip that opens the release page, with no panel", () => {
      const onOpenPage = vi.fn<() => void>()
      const page = render(withChip({ version: "0.0.81", onOpenPage }))
      mounted.push(page)
      const pressed = button(page)!
      expect(pressed.getAttribute("aria-label")).toBe("Update available: Novadeck 0.0.81")
      expect(pressed.textContent).toBe("Update available")
      expect(pressed.querySelector(".footer-chip-dot")).not.toBeNull()
      expect(pressed.classList.contains("footer-update")).toBe(true)
      expect(pressed.hasAttribute("aria-expanded")).toBe(false)
      act(() => pressed.click())
      expect(onOpenPage).toHaveBeenCalledOnce()
      expect(page.container.querySelector("section")).toBeNull()
    })

    it("folds to its icon once its page was opened, until another release", () => {
      const onOpenPage = vi.fn<() => void>()
      const page = render(withChip({ version: "0.0.81", onOpenPage }))
      mounted.push(page)
      const words = () => button(page)!.querySelector(".footer-chip-text")!
      expect(words().classList.contains("hidden")).toBe(false)
      act(() => button(page)!.click())
      expect(onOpenPage).toHaveBeenCalledOnce()
      expect(words().classList.contains("hidden")).toBe(true)
      expect(button(page)!.getAttribute("aria-label")).toBe("Update available: Novadeck 0.0.81")
      page.rerender(withChip({ version: "0.0.82", onOpenPage }))
      expect(words().classList.contains("hidden")).toBe(false)
    })

    it("keeps the fold across a reload, and never folds Allow updates", () => {
      const onOpenPage = vi.fn<() => void>()
      const first = render(withChip({ version: "0.0.81", onOpenPage }))
      act(() => button(first)!.click())
      first.unmount()
      const again = render(withChip({ version: "0.0.81", onOpenPage }))
      mounted.push(again)
      const words = () => button(again)!.querySelector(".footer-chip-text")!
      expect(words().classList.contains("hidden")).toBe(true)
      expect(button(again)!.title).toBe("Update available · Opens the release page")
      again.rerender(withChip({ version: "0.0.82", onOpenPage, onAllow: () => {} }))
      act(() => button(again)!.click())
      expect(words().classList.contains("hidden")).toBe(false)
    })

    it("asks for an administrator, as Allow updates, when it can be let install itself", () => {
      const onAllow = vi.fn<() => void>()
      const onOpenPage = vi.fn<() => void>()
      const page = render(withChip({ version: "0.0.81", onOpenPage, onAllow }))
      mounted.push(page)
      const pressed = button(page)!
      expect(pressed.getAttribute("aria-label")).toBe("Allow updates: Novadeck 0.0.81")
      expect(pressed.textContent).toBe("Allow updates")
      expect(pressed.getAttribute("aria-description")).toContain("administrator's password")
      expect(pressed.title).toContain("administrator's password")
      expect(
        [...page.container.querySelectorAll(".sr-only[role=status]")].at(-2)?.textContent,
      ).toBe("Allow updates")
      act(() => pressed.click())
      expect(onAllow).toHaveBeenCalledOnce()
      expect(onOpenPage).not.toHaveBeenCalled()
    })

    it("announces its arrival once, in a polite live region that stays mounted", () => {
      const page = render(withChip())
      mounted.push(page)
      const regions = () => [...page.container.querySelectorAll(".sr-only[role=status]")]
      const region = regions().at(-2)!
      expect(region.textContent).toBe("")
      page.rerender(withChip({ version: "0.0.81", onOpenPage: () => {} }))
      expect(regions().at(-2)).toBe(region)
      expect(region.getAttribute("aria-live")).toBe("polite")
      expect(region.textContent).toBe("Update available")
    })

    it("goes with the footer in Zen mode", () => {
      const page = render(
        createElement(WorkspaceFooter, {
          hidden: true,
          count: 2,
          running: 1,
          status: "ok",
          available: { version: "0.0.81", onOpenPage: () => {} },
        }),
      )
      mounted.push(page)
      expect(page.container.querySelector("footer")?.hasAttribute("hidden") ?? true).toBe(true)
    })
  })

  context("on a portable copy", () => {
    const withUpdate = (status: FooterStatus, update?: UpdateOffer) => {
      const page = render(createElement(WorkspaceFooter, props(status, update)))
      mounted.push(page)
      return page
    }
    it("keeps a polite live region mounted, empty until a release is missing, then fills it", () => {
      const page = withUpdate("ok")
      const region = announcer(page)
      expect(region.getAttribute("aria-live")).toBe("polite")
      expect(region.textContent).toBe("")
      page.rerender(createElement(WorkspaceFooter, props("ok", ready)))
      expect(announcer(page)).toBe(region)
      expect(region.textContent).toBe("Update available")
    })

    it("offers Install Novadeck alone while no release is known, narrowed to its icon", () => {
      const page = withUpdate("ok")
      expect(chip(page).getAttribute("aria-label")).toBe("Install Novadeck")
      expect(chip(page).textContent).toBe("Install Novadeck")
      expect(chip(page).querySelector(".footer-chip-text")!.className).toContain(
        "max-[701px]:hidden",
      )
      expect(chip(page).querySelector(".footer-chip-dot")).toBeNull()
    })

    it("says Update available on the chip for a missing release, with a dot on its icon", () => {
      const page = withUpdate("ok", ready)
      expect(chip(page).getAttribute("aria-label")).toBe("Update available: Novadeck 0.0.80")
      expect(chip(page).textContent).toBe("Update available")
      expect(chip(page).querySelector(".footer-chip-dot")).not.toBeNull()
    })

    it("folds the chip to its icon once its card was closed, until another release", () => {
      const open = (update: UpdateOffer) => {
        const base = props("ok", update)
        return createElement(WorkspaceFooter, {
          ...base,
          portable: { ...base.portable, open: true },
        })
      }
      const page = render(open(ready))
      mounted.push(page)
      const words = () => chip(page).querySelector(".footer-chip-text")!
      expect(words().classList.contains("hidden")).toBe(false)
      act(() =>
        [...page.container.querySelectorAll("button")]
          .find((b) => b.getAttribute("aria-label") === "Dismiss")!
          .click(),
      )
      expect(words().classList.contains("hidden")).toBe(true)
      expect(chip(page).title).toBe("Update available")
      expect(chip(page).querySelector(".footer-chip-dot")).not.toBeNull()
      page.rerender(open({ ...ready, version: "0.0.81" }))
      expect(words().classList.contains("hidden")).toBe(false)
    })

    it("keeps its words on a card closed with no release, and the fold across a reload", () => {
      const open = (update?: UpdateOffer) => {
        const base = props("ok", update)
        return createElement(WorkspaceFooter, {
          ...base,
          portable: { ...base.portable, open: true },
        })
      }
      const dismiss = (page: Rendered) =>
        act(() =>
          [...page.container.querySelectorAll("button")]
            .find((b) => b.getAttribute("aria-label") === "Dismiss")!
            .click(),
        )
      const first = render(open(ready))
      dismiss(first)
      first.unmount()
      const again = render(open(ready))
      mounted.push(again)
      const words = () => chip(again).querySelector(".footer-chip-text")!
      expect(words().classList.contains("hidden")).toBe(true)
      again.rerender(open())
      expect(words().classList.contains("hidden")).toBe(false)
      dismiss(again)
      expect(words().classList.contains("hidden")).toBe(false)
      again.rerender(open(ready))
      expect(words().classList.contains("hidden")).toBe(true)
    })

    it("leaves the bar's tone and the link's status to the connection", () => {
      const page = withUpdate("unavailable", ready)
      const bar = page.container.querySelector("footer")!
      expect(bar.dataset["tone"]).toBe("danger")
      expect(bar.textContent).toContain("Offline")
      expect(bar.textContent).toContain("Update available")
      expect(bar.querySelector(".footer-status [role=status]")?.textContent).toBe("Offline")
    })

    context("whose notice is raised", () => {
      const raised = (
        { hidden = false, blocked = false } = {},
        onShown = () => {},
        offer: UpdateOffer | null = ready,
      ) =>
        createElement(WorkspaceFooter, {
          ...props("ok"),
          hidden,
          portable: {
            offer: offer ?? undefined,
            portable,
            open: true,
            blocked,
            returnFocus: () => false,
            onOpenChange: () => {},
            onShown,
          },
        })

      it("is not shown while the footer is hidden, and is with the footer", () => {
        const onShown = vi.fn<() => void>()
        const page = render(raised({ hidden: true }, onShown))
        mounted.push(page)
        expect(notice(page)).toBeNull()
        expect(onShown).not.toHaveBeenCalled()
        page.rerender(raised({}, onShown))
        expect(notice(page)).not.toBeNull()
        expect(onShown).toHaveBeenCalledOnce()
      })

      it("is not shown, nor marked shown, while a dialog is open", () => {
        const onShown = vi.fn<() => void>()
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
          "Novadeck 0.0.80 is out",
        )
        expect(region.closest("footer")).not.toBeNull()
        expect(region.contains(document.activeElement)).toBe(false)
      })

      it("says what an offered release means, with a dismiss and Install", () => {
        const page = render(raised())
        mounted.push(page)
        const region = notice(page)!
        expect(region.textContent).toContain("This copy can't update itself.")
        expect(region.textContent).toContain("Keeps your workspace")
        const buttons = [...region.querySelectorAll("button")].map(
          (b) => b.getAttribute("aria-label") ?? b.textContent,
        )
        expect(buttons).toEqual(["Dismiss", "Install Novadeck"])
        expect(region.textContent).not.toContain("Release notes")
      })

      // The card open with the host's account of the install, which is all it shows.
      const installing = (install: PortableInstall, onInstall = () => {}) =>
        createElement(WorkspaceFooter, {
          ...props("ok"),
          portable: {
            ...props("ok").portable,
            open: true,
            portable: { ...portable, install, onInstall },
          },
        })

      // The card for the offered release, with the host's folder, notes and calls.
      const withNotes = (
        aside: Partial<FooterPortable> & {
          news?: WhatsNew | undefined
          newsSettled?: boolean
          onShown?: () => void
        } = {},
      ) => {
        const { news, newsSettled, onShown, ...more } = aside
        return createElement(WorkspaceFooter, {
          ...props("ok", ready),
          portable: {
            ...props("ok", ready).portable,
            open: true,
            news,
            ...(newsSettled === undefined ? {} : { newsSettled }),
            ...(onShown ? { onShown } : {}),
            portable: { ...portable, ...more },
          },
        })
      }
      const buttonNames = (page: Rendered) =>
        [...notice(page)!.querySelectorAll("button")].map(
          (b) => b.getAttribute("aria-label") ?? b.textContent,
        )
      const notes: WhatsNew = {
        version: "0.0.80",
        from: "0.0.70",
        highlights: ["a", "b", "c", "d", "e"].map((title) => ({ title, line: `${title} line` })),
      }

      it("lists the release's highlights, four at most, under its tape and the version it is new since", () => {
        const page = render(withNotes({ news: notes }))
        mounted.push(page)
        const region = notice(page)!
        expect(region.classList.contains("whats-new")).toBe(true)
        expect(document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe(
          "New in Novadeck 0.0.80",
        )
        expect(region.querySelector(".whats-new-from")?.textContent).toBe("From 0.0.70")
        expect([...region.querySelectorAll(".whats-new-title")].map((t) => t.textContent)).toEqual([
          "a",
          "b",
          "c",
          "d",
        ])
        expect(region.textContent).not.toContain("This copy can't update itself.")
      })

      it("falls back to the title and line without notes", () => {
        const page = render(withNotes())
        mounted.push(page)
        expect(notice(page)!.classList.contains("whats-new")).toBe(false)
        expect(notice(page)!.textContent).toContain("Novadeck 0.0.80 is out")
        expect(notice(page)!.textContent).toContain("This copy can't update itself.")
      })

      it("says where the workspace stays, with a button to show it, and drops the vague line for it", () => {
        const onShowFolder = vi.fn<() => void>()
        const page = render(withNotes({ dataFolder: "/home/me/.config/novadeck", onShowFolder }))
        mounted.push(page)
        const region = notice(page)!
        expect(region.querySelector(".portable-data")?.textContent).toContain(
          "Your workspace stays in /home/me/.config/novadeck",
        )
        expect(region.querySelector(".portable-path")?.textContent).toBe(
          "/home/me/.config/novadeck",
        )
        expect(region.textContent).not.toContain("Keeps your workspace")
        act(() =>
          [...region.querySelectorAll("button")]
            .find((b) => b.getAttribute("aria-label") === "Show folder")!
            .click(),
        )
        expect(onShowFolder).toHaveBeenCalledOnce()
      })

      it("has no data line, or button, where the host can't say the folder or show it", () => {
        const page = render(withNotes({ dataFolder: "/home/me/x" }))
        mounted.push(page)
        expect(notice(page)!.querySelector(".portable-data")).not.toBeNull()
        expect(buttonNames(page)).not.toContain("Show folder")
        page.rerender(withNotes())
        expect(notice(page)!.querySelector(".portable-data")).toBeNull()
      })

      it("offers Get new portable only with a release and a host that opens the download", () => {
        const onDownload = vi.fn<() => void>()
        const page = render(withNotes({ onDownload }))
        mounted.push(page)
        expect(buttonNames(page)).toEqual(["Dismiss", "Get new portable", "Install Novadeck"])
        act(() =>
          [...notice(page)!.querySelectorAll("button")]
            .find((b) => b.textContent === "Get new portable")!
            .click(),
        )
        expect(onDownload).toHaveBeenCalledOnce()
        page.rerender(withNotes())
        expect(buttonNames(page)).toEqual(["Dismiss", "Install Novadeck"])
        page.rerender(
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              offer: undefined,
              open: true,
              portable: { ...portable, onDownload },
            },
          }),
        )
        expect(buttonNames(page)).toEqual(["Dismiss", "Install Novadeck"])
      })

      it("drops notes of another release than the offer's", () => {
        const page = render(withNotes({ news: { ...notes, version: "0.0.79" } }))
        mounted.push(page)
        expect(notice(page)!.classList.contains("whats-new")).toBe(false)
        expect(notice(page)!.textContent).toContain("Novadeck 0.0.80 is out")
      })

      it("holds the automatic raise for the notes' first answer, and the chip opens it at once", () => {
        const onShown = vi.fn<() => void>()
        const page = render(withNotes({ newsSettled: false, onShown }))
        mounted.push(page)
        expect(notice(page)).toBeNull()
        expect(onShown).not.toHaveBeenCalled()
        page.rerender(withNotes({ newsSettled: true, news: notes, onShown }))
        expect(notice(page)!.classList.contains("whats-new")).toBe(true)
        expect(onShown).toHaveBeenCalledOnce()
        page.rerender(withNotes({ newsSettled: false, onShown }))
        act(() => chip(page).click())
        expect(notice(page)).not.toBeNull()
      })

      it("keeps the card's look when the notes come while it shows", () => {
        const page = render(withNotes({ newsSettled: true }))
        mounted.push(page)
        expect(notice(page)!.classList.contains("whats-new")).toBe(false)
        page.rerender(withNotes({ newsSettled: true, news: notes }))
        expect(notice(page)!.classList.contains("whats-new")).toBe(false)
      })

      it("offers Get new portable after a failed install too, saying it opens the browser", () => {
        const onDownload = vi.fn<() => void>()
        const card = (install: PortableInstall) =>
          createElement(WorkspaceFooter, {
            ...props("ok", ready),
            portable: {
              ...props("ok", ready).portable,
              open: true,
              portable: { ...portable, onDownload, install },
            },
          })
        const page = render(card({ phase: "idle" }))
        mounted.push(page)
        // A failure seen as it happens, not one from before the page loaded.
        page.rerender(card({ phase: "failed", reason: "No space." }))
        expect(buttonNames(page)).toEqual(["Dismiss", "Get new portable", "Try again"])
        const button = [...notice(page)!.querySelectorAll("button")].find(
          (b) => b.textContent === "Get new portable",
        )!
        expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
          "Opens novadeck.dev in your browser",
        )
      })

      it("asks the host to install, and shows nothing of it until the host says", () => {
        const onInstall = vi.fn<() => void>()
        const page = render(installing({ phase: "idle" }, onInstall))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        expect(onInstall).toHaveBeenCalledOnce()
        expect(notice(page)!.textContent).not.toContain("Installing Novadeck")
      })

      it("shows a determinate bar and the percent while the host reports a download", () => {
        const page = render(installing({ phase: "downloading", percent: 42 }))
        mounted.push(page)
        expect(notice(page)!.textContent).toContain("Installing Novadeck")
        expect(notice(page)!.textContent).toContain("Downloading…")
        expect(notice(page)!.textContent).toContain("42%")
        expect(notice(page)!.querySelector("[data-state=indeterminate]")).toBeNull()
        page.rerender(installing({ phase: "installing" }))
        expect(notice(page)!.textContent).toContain("Keeps your workspace")
        expect(notice(page)!.querySelector("[data-state=indeterminate]")).not.toBeNull()
      })

      it("finds the install done in a window opened again after it", () => {
        const page = render(
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              portable: { ...portable, install: { phase: "installed" } },
            },
          }),
        )
        mounted.push(page)
        expect(chip(page).textContent).toBe("Installed")
        expect(notice(page)).toBeNull()
      })

      it("says a portable copy needs an installed Novadeck when no release is known", () => {
        const page = render(raised({}, undefined, null))
        mounted.push(page)
        const region = notice(page)!
        expect(document.getElementById(region.getAttribute("aria-labelledby")!)?.textContent).toBe(
          "Portable copy",
        )
        expect(region.textContent).toContain("Updates need an installed Novadeck.")
      })

      it("adds a line about the sandbox for a copy running without it", () => {
        const page = render(
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              open: true,
              portable: { ...portable, unsandboxed: true },
            },
          }),
        )
        mounted.push(page)
        expect(notice(page)!.textContent).toContain("Installing also lets you turn on the sandbox.")
      })

      it("shows an indeterminate bar while installing, which can still be folded away", () => {
        const page = render(installing({ phase: "installing" }))
        mounted.push(page)
        const region = notice(page)!
        expect(region.textContent).toContain("Installing Novadeck")
        expect(region.querySelector("[data-state=indeterminate]")).not.toBeNull()
        expect(region.querySelector("[aria-label=Dismiss]")).not.toBeNull()
        expect(chip(page).getAttribute("aria-label")).toBe("Installing…")
        page.rerender(installing({ phase: "installed" }))
        expect(notice(page)!.textContent).toContain("Takes effect after you restart Novadeck")
        expect(chip(page).textContent).toBe("Installed")
      })

      it("says on macOS to quit and reopen, where closing the window doesn't quit", () => {
        const page = render(
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              open: true,
              platform: "mac",
              portable: { ...portable, install: { phase: "installed" } },
            },
          }),
        )
        mounted.push(page)
        expect(notice(page)!.textContent).toContain(
          "Takes effect after you quit and reopen Novadeck",
        )
      })

      it("says why an install failed, and offers to try again", () => {
        const page = render(installing({ phase: "idle" }))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(installing({ phase: "installing" }))
        page.rerender(installing({ phase: "failed", reason: "Disk full" }))
        expect(notice(page)!.textContent).toContain("Couldn't install")
        expect(notice(page)!.textContent).toContain("Disk full")
        expect(notice(page)!.querySelector(".update-card-foot button")!.textContent).toBe(
          "Try again",
        )
      })

      // The card as its parent holds it: open or not, with the install the host reports.
      const held = (install: PortableInstall, open: boolean, aside = {}) =>
        createElement(WorkspaceFooter, {
          ...props("ok"),
          ...("hidden" in aside ? { hidden: aside.hidden as boolean } : {}),
          portable: {
            ...props("ok").portable,
            open,
            ...("blocked" in aside ? { blocked: aside.blocked as boolean } : {}),
            portable: { ...portable, install },
          },
        })
      const failed: PortableInstall = { phase: "failed", reason: "Disk full" }

      it("shows the idle card for a failure the person dismissed, and a repeat of it again", () => {
        const page = render(held({ phase: "idle" }, true))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(held({ phase: "installing" }, true))
        page.rerender(held(failed, true))
        expect(notice(page)!.textContent).toContain("Couldn't install")
        act(() => notice(page)!.querySelector<HTMLButtonElement>("[aria-label=Dismiss]")!.click())
        page.rerender(held(failed, false))
        act(() => chip(page).click())
        page.rerender(held(failed, true))
        expect(notice(page)!.textContent).toContain("Portable copy")
        expect(notice(page)!.querySelector(".update-card-foot button")!.textContent).toBe(
          "Install Novadeck",
        )
        // Install again; the same failure comes back and shows.
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(held({ phase: "installing" }, true))
        page.rerender(held(failed, true))
        expect(notice(page)!.textContent).toContain("Couldn't install")
        expect(notice(page)!.textContent).toContain("Disk full")
      })

      it("counts a failed card closed by the parent as dismissed", () => {
        const page = render(held({ phase: "idle" }, true))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(held({ phase: "installing" }, true))
        page.rerender(held(failed, true))
        page.rerender(held(failed, false))
        page.rerender(held(failed, true))
        expect(notice(page)!.textContent).toContain("Portable copy")
      })

      it("shows a failure that arrives in the same render as the card folding", () => {
        const page = render(held({ phase: "idle" }, true))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(held({ phase: "installing" }, true))
        page.rerender(held(failed, false))
        page.rerender(held(failed, true))
        expect(notice(page)!.textContent).toContain("Disk full")
      })

      it("keeps a failure through the card being blocked or the footer hidden", () => {
        const page = render(held({ phase: "idle" }, true))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(held({ phase: "installing" }, true))
        page.rerender(held(failed, true))
        page.rerender(held(failed, true, { blocked: true }))
        expect(notice(page)).toBeNull()
        page.rerender(held(failed, true, { blocked: false }))
        expect(notice(page)!.textContent).toContain("Disk full")
        page.rerender(held(failed, true, { hidden: true }))
        expect(notice(page)).toBeNull()
        page.rerender(held(failed, true, { hidden: false }))
        expect(notice(page)!.textContent).toContain("Disk full")
      })

      it("leaves a window that never pressed Install to show only the chip when it ends", () => {
        vi.useFakeTimers()
        const onOpenChange = vi.fn<(open: boolean) => void>()
        const other = (install: PortableInstall, open = false) =>
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              open,
              onOpenChange,
              portable: { ...portable, install },
            },
          })
        const page = render(other({ phase: "idle" }))
        mounted.push(page)
        page.rerender(other({ phase: "installing" }))
        expect(chip(page).textContent).toBe("Installing…")
        page.rerender(other({ phase: "installed" }))
        expect(chip(page).textContent).toBe("Installed")
        expect(onOpenChange).not.toHaveBeenCalled()
        // Opened by the person, it shows the outcome, without lingering to fade by itself.
        page.rerender(other({ phase: "installed" }, true))
        expect(notice(page)!.textContent).toContain("Novadeck installed")
        // Each step of a linger is its own timer, set once the step before has rendered.
        act(() => vi.advanceTimersByTime(finishedForMs + 100))
        act(() => vi.advanceTimersByTime(fadeMs + 100))
        expect(notice(page)).not.toBeNull()
        expect(onOpenChange).not.toHaveBeenCalledWith(false)
      })

      it("raises the card only for the install this window asked for, not a later one", () => {
        const onOpenChange = vi.fn<(open: boolean) => void>()
        const card = (install: PortableInstall, open: boolean) =>
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              open,
              onOpenChange,
              portable: { ...portable, install },
            },
          })
        const page = render(card({ phase: "idle" }, true))
        mounted.push(page)
        act(() =>
          notice(page)!.querySelector<HTMLButtonElement>(".update-card-foot button")!.click(),
        )
        page.rerender(card({ phase: "installing" }, false))
        page.rerender(card(failed, false))
        expect(onOpenChange).toHaveBeenLastCalledWith(true)
        onOpenChange.mockClear()
        // Another window tries again and fails; this one did not ask this time.
        page.rerender(card(failed, false))
        page.rerender(card({ phase: "installing" }, false))
        page.rerender(card(failed, false))
        expect(onOpenChange).not.toHaveBeenCalledWith(true)
        // Nor does it show that failure: it was the other window's person who met it.
        page.rerender(card(failed, true))
        expect(notice(page)!.textContent).toContain("Portable copy")
        expect(page.container.querySelector("[role=alert]")).toBeNull()
      })

      it("shows no alert in a window that never pressed Install when the install fails", () => {
        const onOpenChange = vi.fn<(open: boolean) => void>()
        const other = (install: PortableInstall, open: boolean) =>
          createElement(WorkspaceFooter, {
            ...props("ok"),
            portable: {
              ...props("ok").portable,
              open,
              onOpenChange,
              portable: { ...portable, install },
            },
          })
        const page = render(other({ phase: "installing" }, false))
        mounted.push(page)
        page.rerender(other(failed, false))
        expect(onOpenChange).not.toHaveBeenCalled()
        page.rerender(other(failed, true))
        expect(page.container.querySelector("[role=alert]")).toBeNull()
        expect(notice(page)!.textContent).toContain("Portable copy")
      })

      it("shows the idle card for a failure from before the page loaded", () => {
        const page = render(held(failed, true))
        mounted.push(page)
        expect(notice(page)!.textContent).toContain("Portable copy")
        expect(notice(page)!.textContent).not.toContain("Couldn't install")
      })

      it("reports a newer installed copy as the outcome", () => {
        const page = render(installing({ phase: "newer", version: "0.0.90" }))
        mounted.push(page)
        expect(notice(page)!.textContent).toContain("Novadeck 0.0.90 is already installed")
        expect(chip(page).textContent).toBe("Installed")
      })

      context("with a menu or a hover card already in the page", () => {
        it("does not show, nor count as shown, until the menu is gone", () => {
          vi.useFakeTimers()
          const menu = added('<div role="menu"></div>')
          const onShown = vi.fn<() => void>()
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
        const dismiss = page.container.querySelector<HTMLButtonElement>("[aria-label=Dismiss]")!
        dismiss.focus()
        act(() => dismiss.click())
        expect(document.activeElement).toBe(chip(page))
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
    expect(page.container.querySelector(".update-card")).toBeNull()
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

describe("the footer's feedback slot", () => {
  it("shows what it is given after the usage readout, and nothing without", () => {
    const page = render(
      createElement(WorkspaceFooter, {
        hidden: false,
        count: 1,
        running: 0,
        status: "ok",
        usage: createElement("span", { id: "usage" }),
        feedback: createElement("button", { id: "feedback" }),
      }),
    )
    mounted.push(page)
    const usage = page.container.querySelector("#usage")!
    expect(usage.nextElementSibling?.id).toBe("feedback")
    expect(show("ok").bar().querySelector("#feedback")).toBeNull()
  })
})
