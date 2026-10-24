import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { vi } from "vitest"

import { describe, expect, it } from "./test"
import { createToasts, ToastRegion } from "./Toast"
import { clickGraceMs } from "./toast-rules"

const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms))

// The clock the click guard reads, which a test moves by hand.
let clock = 1000
const mount = (onMore = () => {}) => {
  vi.spyOn(performance, "now").mockImplementation(() => clock)
  const toasts = createToasts<string>()
  const selected: string[] = []
  const props = {
    toasts,
    label: "Things",
    onSelect: (data: string) => void selected.push(data),
    onMore,
    children: (data: string) => createElement("span", { className: "body" }, data),
  }
  const view = render(createElement(ToastRegion<string>, props))
  const doc = view.container.ownerDocument
  const all = (selector: string): HTMLElement[] => [...doc.querySelectorAll<HTMLElement>(selector)]
  const standing = (): string[] =>
    all(".toast:not([data-state=closed]) .body").map((each) => each.textContent ?? "")
  const later = (ms: number) =>
    act(async () => {
      clock += ms
      await sleep(30)
    })
  // The pointer travels onto the stack: Zag hears a move over it.
  const hover = () =>
    act(async () => {
      const move = new MouseEvent("mousemove", { bubbles: true })
      Object.defineProperty(move, "movementX", { value: 8 })
      doc.querySelector(".toasts")!.dispatchEvent(move)
      await sleep(10)
    })
  return { toasts, selected, view, standing, all, later, hover, doc }
}

describe("a toast stack", () => {
  it("shows the newest first, and a key's newer toast replaces its older", async () => {
    const { toasts, standing, view } = mount()
    await act(async () => {
      toasts.show("a", "first")
      toasts.show("b", "second")
    })
    expect(standing()).toEqual(["second", "first"])
    await act(async () => toasts.show("a", "first again"))
    expect(standing()).toEqual(["first again", "second"])
    view.unmount()
  })

  it("ignores a click as a toast lands, and answers one after", async () => {
    const { toasts, selected, standing, view, later, all } = mount()
    await act(async () => toasts.show("a", "ring"))
    await act(async () => all(".body")[0]!.click())
    expect(selected).toEqual([])
    expect(standing()).toEqual(["ring"])
    await later(clickGraceMs + 1)
    await act(async () => all(".body")[0]!.click())
    expect(selected).toEqual(["ring"])
    await later(300)
    expect(standing()).toEqual([])
    view.unmount()
  })

  it("ignores a click on its close button too, until the guard has passed", async () => {
    const { toasts, standing, view, later, all } = mount()
    await act(async () => toasts.show("a", "ring"))
    await act(async () => all(".toast-close")[0]!.click())
    expect(standing()).toEqual(["ring"])
    await later(clickGraceMs + 1)
    await act(async () => all(".toast-close")[0]!.click())
    await later(10)
    expect(standing()).toEqual([])
    view.unmount()
  })

  it("ignores a click on a toast that is leaving, or on its ghost layer", async () => {
    const { toasts, selected, view, later, all } = mount()
    await act(async () => toasts.show("a", "old"))
    await later(clickGraceMs + 1)
    await act(async () => all("[data-ghost=after]")[0]!.click())
    expect(selected).toEqual([])
    await act(async () => toasts.show("a", "new"))
    await later(clickGraceMs + 1)
    const old = all(".toast").find((each) => each.textContent?.includes("old"))
    if (old) {
      expect(old.getAttribute("data-state")).toBe("closed")
      await act(async () => old.click())
    }
    expect(selected).toEqual([])
    view.unmount()
  })

  it("ignores a click on a toast that has just moved to where the pointer is", async () => {
    const { toasts, selected, view, later, all } = mount()
    await act(async () => {
      toasts.show("a", "back")
      toasts.show("b", "front")
    })
    await later(clickGraceMs + 1)
    // A third lands in front: "front" moves back a place.
    await act(async () => toasts.show("c", "newest"))
    const moved = all(".toast").find((each) => each.textContent?.includes("front"))!
    await act(async () => moved.click())
    expect(selected).toEqual([])
    view.unmount()
  })

  it("takes no focus from a press, and gives it back after a key", async () => {
    const { toasts, view, later, all, doc } = mount()
    const field = doc.createElement("input")
    doc.body.append(field)
    field.focus()
    await act(async () => toasts.show("a", "ring"))
    const press = new MouseEvent("mousedown", { bubbles: true, cancelable: true })
    all(".toast")[0]!.dispatchEvent(press)
    expect(press.defaultPrevented).toBe(true)
    // Tab into the toast, then Enter on it.
    await act(async () => all(".toast")[0]!.focus())
    await later(clickGraceMs + 1)
    await act(async () => {
      all(".toast")[0]!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      )
    })
    await later(10)
    expect(doc.activeElement).toBe(field)
    field.remove()
    view.unmount()
  })

  it("lets a toast that is leaving fade out where it stood", async () => {
    const { toasts, view, later, all } = mount()
    await act(async () => {
      toasts.show("a", "back")
      toasts.show("b", "front")
    })
    await later(10)
    await act(async () => toasts.close("b"))
    await later(10)
    const leaving = all(".toast").find((each) => each.textContent?.includes("front"))
    expect(leaving?.getAttribute("data-state")).toBe("closed")
    expect(leaving?.getAttribute("data-rank")).toBe("0")
    view.unmount()
  })
})

describe("a stack the pointer holds", () => {
  it("stops holding once its last toast is gone, so the next runs its own time", async () => {
    const { toasts, view, later, hover, all } = mount()
    await act(async () => toasts.show("a", "ring"))
    await hover()
    expect(all(".toast")[0]!.hasAttribute("data-paused")).toBe(true)
    await later(clickGraceMs + 1)
    await act(async () => all(".toast-close")[0]!.click())
    await later(400)
    await act(async () => toasts.show("b", "again"))
    await later(50)
    expect(all(".toast")[0]!.hasAttribute("data-paused")).toBe(false)
    view.unmount()
  })

  it("spreads a toast that lands while it is held", async () => {
    const { toasts, view, later, hover, all } = mount()
    const matches = HTMLElement.prototype.matches
    vi.spyOn(HTMLElement.prototype, "matches").mockImplementation(function (
      this: HTMLElement,
      selector: string,
    ) {
      return selector.includes(":hover") || matches.call(this, selector)
    })
    await act(async () => toasts.show("a", "ring"))
    await hover()
    await act(async () => toasts.show("b", "more"))
    await later(50)
    const front = all(".toast").find((each) => each.textContent?.includes("more"))!
    expect(front.hasAttribute("data-stack")).toBe(true)
    view.unmount()
  })
})

describe("the pill that counts the rest", () => {
  it("is pressed where the pointer reached it, the stack not spreading under it", async () => {
    let more = 0
    const { toasts, view, later, all, doc } = mount(() => void (more += 1))
    await act(async () => {
      for (const key of ["a", "b", "c", "d", "e"]) toasts.show(key, key)
    })
    await later(clickGraceMs + 1)
    const pill = all('.toast-more[data-fan="rest"]')[0]!
    await act(async () => {
      pill.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }))
      const move = new MouseEvent("mousemove", { bubbles: true })
      Object.defineProperty(move, "movementX", { value: 20 })
      pill.dispatchEvent(move)
      await sleep(10)
    })
    expect(doc.querySelector(".toast[data-stack]")).toBeNull()
    await act(async () => pill.click())
    expect(more).toBe(1)
    view.unmount()
  })
})
