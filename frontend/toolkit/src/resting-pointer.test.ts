import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { useRestingPointer } from "./resting-pointer"
import { context, describe, expect, it } from "./test"

beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => vi.useRealTimers())

// A trigger that counts each time the pointer comes to rest on it.
const mount = (delay = 100) => {
  const rests: string[] = []
  const Trigger = ({ name }: { readonly name: string }) => {
    const resting = useRestingPointer(delay, () => void rests.push(name))
    return createElement("button", { type: "button", ...resting.handlers }, name)
  }
  const view = render(createElement(Trigger, { name: "first" }))
  const button = view.container.querySelector("button")!
  const pointer = (type: string, pointerType = "mouse") =>
    act(() => {
      button.dispatchEvent(new PointerEvent(type, { bubbles: true, pointerType }))
    })
  // React hears a leave as the pointer moves out to another element.
  const leave = () =>
    act(() => {
      button.dispatchEvent(
        new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }),
      )
    })
  const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms))
  return { rests, view, pointer, leave, wait, rerender: Trigger }
}

describe("a pointer resting on a trigger", () => {
  it("rests once it has held still for the delay", () => {
    const { rests, view, pointer, wait } = mount()
    pointer("pointermove")
    wait(99)
    expect(rests).toEqual([])
    wait(1)
    expect(rests).toEqual(["first"])
    view.unmount()
  })

  it("starts the wait again with every move, so sweeping across rests nowhere", () => {
    const { rests, view, pointer, wait } = mount()
    pointer("pointermove")
    wait(60)
    pointer("pointermove")
    wait(60)
    expect(rests).toEqual([])
    wait(40)
    expect(rests).toEqual(["first"])
    view.unmount()
  })

  it("gives up the wait as it leaves", () => {
    const { rests, view, pointer, leave, wait } = mount()
    pointer("pointermove")
    leave()
    wait(200)
    expect(rests).toEqual([])
    view.unmount()
  })

  it("calls what the trigger offers as it rests, not what it offered when the wait began", () => {
    const { rests, view, pointer, wait, rerender } = mount()
    pointer("pointermove")
    view.rerender(createElement(rerender, { name: "second" }))
    wait(100)
    expect(rests).toEqual(["second"])
    view.unmount()
  })

  it("stops waiting once the trigger has gone", () => {
    const { rests, view, pointer, wait } = mount()
    pointer("pointermove")
    view.unmount()
    wait(200)
    expect(rests).toEqual([])
  })

  context("after a press", () => {
    it("doesn't rest again until it has left", () => {
      const { rests, view, pointer, leave, wait } = mount()
      pointer("pointermove")
      pointer("pointerdown")
      wait(200)
      pointer("pointermove")
      wait(200)
      expect(rests).toEqual([])
      leave()
      pointer("pointermove")
      wait(100)
      expect(rests).toEqual(["first"])
      view.unmount()
    })
  })

  context("by touch", () => {
    it("never rests", () => {
      const { rests, view, pointer, wait } = mount()
      pointer("pointermove", "touch")
      wait(200)
      expect(rests).toEqual([])
      view.unmount()
    })
  })
})
