import { render } from "@novadeck/test-kit/render"
import { Shown } from "@novadeck/toolkit/shown"
import { act, createElement, useEffect } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { arrivingMs, graceMs, settleMs, useWakeful } from "./awake"
import { describe, expect, it } from "./test"

const unmounts: (() => void)[] = []
beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "performance", "Date"],
  })
})
afterEach(() => {
  unmounts.splice(0).forEach((unmount) => unmount())
  vi.useRealTimers()
})

// A pane's sheet, awake as the hook says, with a field to focus inside it; `wake` is
// its pane's, as a view inside it would call it.
const sheet = (shown = true) => {
  const pane = { wake: () => {} }
  const Sheet = (): React.JSX.Element => {
    const { awake, ref, on } = useWakeful()
    useEffect(() => {
      pane.wake = awake.wake
    }, [awake])
    return createElement(
      "div",
      { ...on, ref, "data-testid": "sheet", "data-awake": awake.awake },
      createElement("input", { "aria-label": "field" }),
    )
  }
  const element = (visible: boolean) =>
    createElement(Shown, { value: visible }, createElement(Sheet))
  const rendered = render(element(shown))
  unmounts.push(rendered.unmount)
  const target = rendered.container.querySelector<HTMLElement>("[data-testid=sheet]")!
  return {
    target,
    awake: () => target.dataset.awake === "true",
    wake: () => act(() => pane.wake()),
    show: (visible: boolean) => rendered.rerender(element(visible)),
    field: () => rendered.container.querySelector("input")!,
  }
}

const pointer = (target: Element, type: string, init: PointerEventInit = {}) =>
  act(() => {
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType: "mouse", ...init }))
  })
const move = (target: Element, init: PointerEventInit = {}) =>
  pointer(target, "pointermove", { movementX: 4, movementY: 2, ...init })
const pass = (ms: number) => act(() => vi.advanceTimersByTime(ms))

describe("a pane's sheet, awake", () => {
  it("sleeps until the person is at it", () => {
    expect(sheet().awake()).toBe(false)
  })

  it("wakes once the pointer that moved onto it stays a moment", () => {
    const { target, awake } = sheet()
    pass(arrivingMs)
    move(target)
    pass(settleMs - 1)
    expect(awake()).toBe(false)
    pass(1)
    expect(awake()).toBe(true)
  })

  it("stays asleep for a pointer only passing over it", () => {
    const { target, awake } = sheet()
    pass(arrivingMs)
    move(target)
    pass(settleMs / 2)
    pointer(target, "pointerout", { relatedTarget: document.body })
    pass(settleMs)
    expect(awake()).toBe(false)
  })

  it("stays asleep as it slides in under a still pointer, or for a touch passing", () => {
    const { target, awake } = sheet()
    move(target)
    pass(settleMs)
    expect(awake()).toBe(false)
    pass(arrivingMs)
    move(target, { movementX: 0, movementY: 0 })
    move(target, { pointerType: "touch" })
    pass(settleMs)
    expect(awake()).toBe(false)
  })

  it("wakes at once on a press, a wheel, a key or focus", () => {
    for (const engage of [
      (target: HTMLElement) => pointer(target, "pointerdown"),
      (target: HTMLElement) =>
        act(() => void target.dispatchEvent(new WheelEvent("wheel", { bubbles: true }))),
      (target: HTMLElement) =>
        act(() => void target.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }))),
    ]) {
      const { target, awake } = sheet()
      engage(target)
      expect(awake()).toBe(true)
    }
    const { field, awake } = sheet()
    act(() => field().focus())
    expect(awake()).toBe(true)
  })

  it("sleeps a while after the person left it, and not while focus is in it", () => {
    const { target, awake, field } = sheet()
    pointer(target, "pointerdown")
    act(() => field().focus())
    pass(graceMs)
    expect(awake()).toBe(true)
    act(() => field().blur())
    pass(graceMs)
    expect(awake()).toBe(false)
  })

  it("sleeps a while after the person leaves, however long they stayed", () => {
    const { target, awake, field } = sheet()
    act(() => field().focus())
    // Long at it: the while it waits is counted from when they leave, not from waking.
    pass(graceMs * 2 - 1_000)
    act(() => field().blur())
    pass(1_000)
    expect(awake()).toBe(true)
    pass(graceMs - 1_000)
    expect(awake()).toBe(false)
    // The same for the pointer leaving.
    pointer(target, "pointerdown")
    pass(graceMs - 1_000)
    pointer(target, "pointerout", { relatedTarget: document.body })
    pass(1_000)
    expect(awake()).toBe(true)
  })

  it("sleeps at once out of sight, and isn't woken there", () => {
    const { target, awake, wake, show } = sheet()
    pointer(target, "pointerdown")
    show(false)
    expect(awake()).toBe(false)
    wake()
    expect(awake()).toBe(false)
    show(true)
    wake()
    expect(awake()).toBe(true)
  })
})
