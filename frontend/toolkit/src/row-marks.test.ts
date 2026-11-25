import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { NeedMark } from "./NeedMark"
import { PhaseGlyph } from "./PhaseGlyph"
import { SidebarItemHandle } from "./SidebarItem"
import { describe, expect, it } from "./test"

const glyph = (props: Parameters<typeof PhaseGlyph>[0]) => {
  const view = render(createElement(PhaseGlyph, props))
  const node = view.container.querySelector<HTMLElement>(".phase-glyph")!
  return { node, view }
}

describe("a phase glyph", () => {
  it("says its phase, and failure only where it is done", () => {
    const done = glyph({ phase: "done", failed: true })
    expect(done.node.dataset.phase).toBe("done")
    expect(done.node.hasAttribute("data-failed")).toBe(true)
    expect(done.node.getAttribute("aria-hidden")).toBe("true")
    done.view.unmount()
    const running = glyph({ phase: "running", failed: true })
    expect(running.node.hasAttribute("data-failed")).toBe(false)
    running.view.unmount()
  })

  it("says what a waiting one waits on, and how full a wake-up's mark is", () => {
    const wake = glyph({ phase: "waiting", wait: { kind: "wake", fill: 2 } })
    expect(wake.node.dataset.wait).toBe("wake")
    expect(wake.node.dataset.wakeFill).toBe("2")
    wake.view.unmount()
    const job = glyph({ phase: "waiting", wait: { kind: "job" } })
    expect(job.node.dataset.wait).toBe("job")
    expect(job.node.hasAttribute("data-wake-fill")).toBe(false)
    job.view.unmount()
  })
})

describe("a need mark", () => {
  it("draws `!`, `?` or a bell-off, hidden only where asked", () => {
    const view = render(createElement(NeedMark, { need: "unblock" }))
    const mark = view.container.querySelector<HTMLElement>(".need-mark")!
    expect(mark.textContent).toBe("!")
    expect(mark.hasAttribute("aria-hidden")).toBe(false)
    view.rerender(createElement(NeedMark, { need: "ask", hidden: true }))
    expect(mark.textContent).toBe("?")
    expect(mark.getAttribute("aria-hidden")).toBe("true")
    view.rerender(createElement(NeedMark, { need: "snoozed" }))
    expect(mark.dataset.need).toBe("snoozed")
    expect(mark.querySelector("svg")).not.toBeNull()
    view.unmount()
  })
})

describe("a row's handle", () => {
  it("is a plain handle chip standing as the row's end, or nothing without one", () => {
    const view = render(createElement(SidebarItemHandle, { handle: "moth" }))
    const chip = view.container.querySelector<HTMLElement>(".handle-chip")!
    expect(chip.textContent).toBe("@moth")
    expect([...chip.classList]).toEqual(
      expect.arrayContaining(["handle-plain", "sidebar-item-handle", "sidebar-item-end"]),
    )
    view.rerender(createElement(SidebarItemHandle, { handle: undefined }))
    expect(view.container.querySelector(".handle-chip")).toBeNull()
    view.unmount()
  })
})
