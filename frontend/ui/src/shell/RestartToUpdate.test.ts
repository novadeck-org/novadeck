import type { UpdateOffer } from "@novadeck/core/desktop/update"
import { render, type Rendered } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import { nothingToCheck, type RestartCheck, type Risk } from "./restart-check"
import { RestartToUpdate, restartingMs, type RestartUpdateProps } from "./RestartToUpdate"

const mounted: Rendered[] = []
afterEach(() => {
  mounted.splice(0).forEach((page) => page.unmount())
  localStorage.clear()
  vi.useRealTimers()
  document.body.replaceChildren()
})

const stops = (id: string, command: string, title: string): Risk => ({
  kind: "stops",
  id,
  title,
  command,
})
const ready = (version = "0.0.81"): UpdateOffer => ({ kind: "ready", version })
const base = (risks: readonly Risk[] = [], over: Partial<RestartUpdateProps> = {}) =>
  ({
    offer: ready(),
    from: "0.0.80",
    check: { ...nothingToCheck, resume: 2, reopen: 9, risks } as RestartCheck,
    answer: "known",
    onRestart: () => {},
    onGoTo: () => {},
    blocked: false,
    ...over,
  }) satisfies RestartUpdateProps

const props = (restart: RestartUpdateProps | undefined, hidden = false) => ({ restart, hidden })
const show = (restart: RestartUpdateProps | undefined, hidden = false) => {
  const page = render(createElement(RestartToUpdate, props(restart, hidden)))
  mounted.push(page)
  return page
}
const chip = (page: Rendered) => page.container.querySelector<HTMLButtonElement>(".footer-chip")
const card = (page: Rendered) => page.container.querySelector<HTMLElement>(".restart-card")
const verdict = (page: Rendered) => card(page)?.querySelector(".restart-verdict")?.textContent
const open = (page: Rendered) => act(() => chip(page)!.click())
const named = (page: Rendered, name: string) =>
  [...page.container.querySelectorAll("button")].find(
    (button) => button.textContent === name || button.ariaLabel === name,
  )!
const press = (page: Rendered, name: string) => act(() => named(page, name).click())
const folded = (page: Rendered) =>
  chip(page)?.querySelector(".footer-chip-text")?.classList.contains("hidden")

describe("restart to update", () => {
  context("without a restart to offer", () => {
    it("has no chip, as in a copy whose app can't restart itself", () => {
      const page = show(undefined)
      expect(chip(page)).toBeNull()
      expect(page.container.querySelector("button")).toBeNull()
    })
  })

  context("with an update waiting", () => {
    it("shows a quiet chip with its dot and no card until it is pressed", () => {
      const page = show(base())
      expect(chip(page)?.textContent).toBe("Restart to update")
      expect(chip(page)?.querySelector(".attention-dot")).not.toBeNull()
      expect(chip(page)?.getAttribute("aria-expanded")).toBe("false")
      expect(card(page)).toBeNull()
    })

    it("says everything comes back when nothing would stop", () => {
      const page = show(base())
      open(page)
      expect(chip(page)?.getAttribute("aria-expanded")).toBe("true")
      expect(card(page)?.textContent).toContain("Restart · 0.0.81")
      expect(card(page)?.textContent).toContain("From 0.0.80")
      expect(verdict(page)).toBe("Everything comes back")
      expect(card(page)?.querySelector(".restart-count")?.textContent).toBe("2 resume · 9 reopen")
      expect(card(page)?.querySelector(".restart-well")).toBeNull()
    })

    it("claims nothing while the runner's word on shells is pending", () => {
      const page = show(base([], { answer: "pending" }))
      open(page)
      expect(verdict(page)).toBe("Checking what a restart keeps…")
      expect(card(page)?.textContent).not.toContain("Everything comes back")
    })

    it("says it couldn't check where the runner can't answer, and never everything", () => {
      const page = show(base([], { answer: "unavailable" }))
      open(page)
      expect(verdict(page)).toBe("Almost everything comes back")
      expect(card(page)?.textContent).toContain("Couldn't check what runs in shells")
    })

    it("leaves out the stamp when the version is unknown and a count that is zero", () => {
      const page = show({
        ...base(),
        from: undefined,
        check: { ...nothingToCheck, reopen: 3 },
      })
      open(page)
      expect(card(page)?.querySelector(".whats-new-from")).toBeNull()
      expect(card(page)?.querySelector(".restart-count")?.textContent).toBe("3 reopen")
    })

    it("names the terminal whose program would stop, with a way to go there", () => {
      const onGoTo = vi.fn<(id: string) => void>()
      const page = show(base([stops("07", "pnpm dev", "Order status page")], { onGoTo }))
      open(page)
      expect(verdict(page)).toBe("Almost everything comes back")
      const well = card(page)!.querySelector(".restart-well")!
      expect(well.textContent).toContain("pnpm dev stops")
      expect(well.textContent).toContain("Order status page · start it again after")
      press(page, "Go to Order status page")
      expect(onGoTo).toHaveBeenCalledWith("07")
      // It leaves the card open.
      expect(card(page)).not.toBeNull()
    })

    it("lists two and counts the rest", () => {
      const page = show(base([stops("1", "a", "A"), stops("2", "b", "B"), stops("3", "c", "C")]))
      open(page)
      expect(card(page)?.querySelectorAll(".restart-item")).toHaveLength(2)
      expect(card(page)?.querySelector(".restart-more")?.textContent).toBe("and 1 more")
    })

    it("never claims nothing stops when it can't see what runs", () => {
      const page = show(base([{ kind: "unknown", id: "4", title: "Stripe webhooks" }]))
      open(page)
      expect(verdict(page)).toBe("Almost everything comes back")
      expect(card(page)?.textContent).toContain("Can't see what runs")
      expect(card(page)?.textContent).toContain("Stripe webhooks · it may stop")
    })

    it("says what an agent waits on that would stop with it", () => {
      const page = show(
        base([
          { kind: "agent", id: "5", title: "Checkout", command: "pnpm test", what: "x" },
          { kind: "agent", id: "6", title: "Orders", what: "2 background commands stop" },
        ]),
      )
      open(page)
      expect(card(page)?.textContent).toContain("pnpm test stops")
      expect(card(page)?.textContent).toContain("Checkout · its agent waits on it")
      expect(card(page)?.textContent).toContain("2 background commands stop")
    })

    it("tells a command run in the agent's shell mode from what it waits on", () => {
      const page = show(
        base([
          {
            kind: "agent",
            id: "5",
            title: "Checkout",
            what: "1 shell command stops",
            shell: "only",
          },
          {
            kind: "agent",
            id: "6",
            title: "Orders",
            what: "1 shell command and 2 background commands stop",
            shell: "mixed",
          },
        ]),
      )
      open(page)
      expect(card(page)?.textContent).toContain("Checkout · run in its agent's shell mode")
      expect(card(page)?.textContent).toContain(
        "Orders · its agent waits on all but its shell command",
      )
    })
  })

  context("pressing Restart now", () => {
    const pressed = () => {
      const onRestart = vi.fn<() => void>()
      const restart = base([], { onRestart })
      const page = show(restart)
      open(page)
      press(page, "Restart now")
      return { page, onRestart, restart }
    }

    it("reads Restarting… on a disabled button", () => {
      const { page, onRestart } = pressed()
      const button = named(page, "Restarting…")
      expect(button.disabled).toBe(true)
      expect(onRestart).toHaveBeenCalledOnce()
    })

    it("does nothing on a second press that reaches the handler anyway", () => {
      const { page, onRestart } = pressed()
      const button = named(page, "Restarting…")
      // As a click that slips past the disabled state, the handler's own guard answers.
      button.removeAttribute("disabled")
      act(() => button.click())
      expect(onRestart).toHaveBeenCalledOnce()
    })

    it("lets the person press again after a while with no quit", () => {
      // Only timeouts: jsdom runs animation frames and focus fixup on its own setInterval,
      // and one started on a fake clock never runs, so later frames would never come.
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
      const { page, onRestart } = pressed()
      act(() => vi.advanceTimersByTime(restartingMs - 1))
      expect(named(page, "Restarting…")).toBeDefined()
      act(() => vi.advanceTimersByTime(1))
      expect(named(page, "Restart now").disabled).toBe(false)
      press(page, "Restart now")
      expect(onRestart).toHaveBeenCalledTimes(2)
    })

    it("lets the person press again once the offer is sent again", () => {
      const { page, restart } = pressed()
      page.rerender(
        createElement(RestartToUpdate, props({ ...restart, offer: { ...restart.offer } })),
      )
      expect(named(page, "Restart now").disabled).toBe(false)
    })
  })

  context("asking the runner once more as it is pressed", () => {
    const pressedWith = async (answer: boolean) => {
      const onRestart = vi.fn<() => void>()
      const recheck = vi.fn<() => Promise<boolean>>(() => Promise.resolve(answer))
      const page = show(base([], { onRestart, recheck }))
      open(page)
      await act(async () => named(page, "Restart now").click())
      return { page, onRestart, recheck }
    }

    it("restarts when nothing new turns up", async () => {
      const { onRestart, recheck, page } = await pressedWith(true)
      expect(recheck).toHaveBeenCalledOnce()
      expect(onRestart).toHaveBeenCalledOnce()
      expect(named(page, "Restarting…").disabled).toBe(true)
    })

    it("does not restart when work turns up the card didn't show, and can be pressed again", async () => {
      const { onRestart, page } = await pressedWith(false)
      expect(onRestart).not.toHaveBeenCalled()
      expect(named(page, "Restart now").disabled).toBe(false)
    })
  })

  context("folding", () => {
    it("folds into the chip on ×, Escape and the chip, which then shows only its icon", () => {
      const page = show(base())
      open(page)
      press(page, "Dismiss")
      expect(card(page)).toBeNull()
      expect(folded(page)).toBe(true)
      open(page)
      act(() => {
        card(page)!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      })
      expect(card(page)).toBeNull()
      open(page)
      act(() => chip(page)!.click())
      expect(card(page)).toBeNull()
    })

    it("holds across a remount, and a newer release brings the word back", () => {
      const first = show(base())
      open(first)
      press(first, "Dismiss")
      first.unmount()
      mounted.pop()
      const again = show(base())
      expect(folded(again)).toBe(true)
      again.rerender(createElement(RestartToUpdate, props(base([], { offer: ready("0.0.82") }))))
      expect(folded(again)).toBe(false)
    })

    it("is its own: the other update chip's fold leaves it alone", () => {
      localStorage.setItem("novadeck.update-chip-folded", "0.0.81")
      expect(folded(show(base()))).toBe(false)
    })
  })

  context("while something else holds the corner", () => {
    it("waits while the footer is hidden or a notice is up, and comes back", () => {
      const page = show(base())
      open(page)
      expect(card(page)).not.toBeNull()
      page.rerender(createElement(RestartToUpdate, props(base([], { blocked: true }))))
      expect(card(page)).toBeNull()
      page.rerender(createElement(RestartToUpdate, props(base())))
      expect(card(page)).not.toBeNull()
      page.rerender(createElement(RestartToUpdate, props(base(), true)))
      expect(card(page)).toBeNull()
    })

    it("opens nothing on a click, now or when it ends, and takes no focus", async () => {
      const terminal = document.createElement("textarea")
      document.body.append(terminal)
      terminal.focus()
      const page = show(base([], { blocked: true }))
      open(page)
      expect(card(page)).toBeNull()
      page.rerender(createElement(RestartToUpdate, props(base())))
      await act(() => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))))
      expect(card(page)).toBeNull()
      expect(document.activeElement).toBe(terminal)
    })

    it("opens nothing on a click while a dialog or menu is open, now or when it closes", () => {
      vi.useFakeTimers({
        toFake: ["setInterval", "setTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
      })
      const terminal = document.createElement("textarea")
      const dialog = document.createElement("div")
      dialog.setAttribute("role", "dialog")
      document.body.append(terminal, dialog)
      terminal.focus()
      const page = show(base())
      open(page)
      expect(card(page)).toBeNull()
      dialog.remove()
      // Long enough for the overlay's own watch to see it gone, which without the click's own
      // guard would let the open that was queued come up, taking focus.
      act(() => vi.advanceTimersByTime(500))
      expect(card(page)).toBeNull()
      expect(document.activeElement).toBe(terminal)
    })

    it("tells when the card shows and goes", () => {
      const onShownChange = vi.fn<(shown: boolean) => void>()
      const page = show(base([], { onShownChange }))
      open(page)
      expect(onShownChange).toHaveBeenLastCalledWith(true)
      press(page, "Dismiss")
      expect(onShownChange).toHaveBeenLastCalledWith(false)
    })
  })

  context("a click on it", () => {
    it("leaves focus where it was", () => {
      const page = show(base())
      open(page)
      const event = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
      card(page)!.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(true)
    })
  })
})
