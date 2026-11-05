import { render } from "@novadeck/test-kit/render"
import { act, createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { useRestingPointer } from "./resting-pointer"
import { context, describe, expect, it } from "./test"

const mounted: (() => void)[] = []
beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }))
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount()
  vi.useRealTimers()
})

// A trigger that counts each time the pointer comes to rest on it.
const mount = (delay = 100) => {
  const rests: string[] = []
  const Trigger = ({ name }: { readonly name: string }) => {
    const resting = useRestingPointer(delay, () => void rests.push(name))
    return createElement("button", { type: "button", ...resting.handlers }, name)
  }
  const view = render(createElement(Trigger, { name: "first" }))
  let gone = false
  const unmount = () => {
    if (gone) return
    gone = true
    view.unmount()
  }
  mounted.push(unmount)
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
  const rerender = (name: string) => view.rerender(createElement(Trigger, { name }))
  return { rests, unmount, rerender, pointer, leave, wait }
}

describe("a pointer resting on a trigger", () => {
  it("rests once it has held still for the delay", () => {
    const { rests, pointer, wait } = mount()
    pointer("pointermove")
    wait(99)
    expect(rests).toEqual([])
    wait(1)
    expect(rests).toEqual(["first"])
  })

  it("starts the wait again with every move, so sweeping across rests nowhere", () => {
    const { rests, pointer, wait } = mount()
    pointer("pointermove")
    wait(60)
    pointer("pointermove")
    wait(60)
    expect(rests).toEqual([])
    wait(40)
    expect(rests).toEqual(["first"])
  })

  it("gives up the wait as it leaves", () => {
    const { rests, pointer, leave, wait } = mount()
    pointer("pointermove")
    leave()
    wait(200)
    expect(rests).toEqual([])
  })

  it("calls what the trigger offers as it rests, not what it offered when the wait began", () => {
    const { rests, rerender, pointer, wait } = mount()
    pointer("pointermove")
    rerender("second")
    wait(100)
    expect(rests).toEqual(["second"])
  })

  it("stops waiting once the trigger has gone", () => {
    const { rests, unmount, pointer, wait } = mount()
    pointer("pointermove")
    unmount()
    wait(200)
    expect(rests).toEqual([])
  })

  context("after a press", () => {
    it("doesn't rest again until it has left", () => {
      const { rests, pointer, leave, wait } = mount()
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
    })
  })

  context("by touch", () => {
    it("never rests", () => {
      const { rests, pointer, wait } = mount()
      pointer("pointermove", "touch")
      wait(200)
      expect(rests).toEqual([])
    })
  })
})
