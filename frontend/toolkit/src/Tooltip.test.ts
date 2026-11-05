import { nextFrame, render } from "@novadeck/test-kit/render"
import { act, createElement, type ComponentProps } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { Shown } from "./shown"
import { describe, expect, it } from "./test"
import { Tooltip } from "./Tooltip"

// jsdom has no layout: an open tooltip's positioning observes no resizes.
Object.assign(globalThis, {
  ResizeObserver: class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  },
})

const mounted: (() => void)[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
})

const mount = (shown = true) => {
  const view = render(tooltip(shown))
  mounted.push(view.unmount)
  return { view, button: view.container.querySelector("button")! }
}

// The pointer holds still for so long, and what that opens is on the page.
const wait = async (ms: number) => {
  act(() => vi.advanceTimersByTime(ms))
  await nextFrame()
}

const tooltip = (shown = true) => {
  const props: ComponentProps<typeof Tooltip> = {
    content: "Rename",
    children: createElement("button", { type: "button", id: "rename" }, "R"),
  }
  return createElement(Shown.Provider, { value: shown }, createElement(Tooltip, props))
}

const open = (): boolean =>
  document.querySelector('[data-scope="tooltip"][data-part="content"][data-state="open"]') !== null

const move = (button: HTMLElement) =>
  act(() => {
    button.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerType: "mouse" }))
  })

describe("a tooltip", () => {
  it("opens once the pointer has rested on its trigger, not as it passes", async () => {
    const { button } = mount()
    move(button)
    await wait(399)
    expect(open()).toBe(false)
    await wait(1)
    expect(open()).toBe(true)
  })

  it("shuts as its trigger goes out of sight", async () => {
    const { view, button } = mount()
    move(button)
    await wait(400)
    expect(open()).toBe(true)
    view.rerender(tooltip(false))
    await nextFrame()
    expect(open()).toBe(false)
  })

  it("stays shut when its trigger goes out of sight while the pointer rests", async () => {
    const { view, button } = mount()
    move(button)
    view.rerender(tooltip(false))
    await wait(400)
    expect(open()).toBe(false)
  })
})
