import { describe, expect, it } from "./test"
import { clickGraceMs, createArrival, ignoresClick, moreOf } from "./toast-rules"

describe("a click on a toast", () => {
  it("does nothing until it has been there a moment", () => {
    expect(ignoresClick(1000, 1000 + clickGraceMs - 1)).toBe(true)
    expect(ignoresClick(1000, 1000 + clickGraceMs)).toBe(false)
  })
})

describe("the toasts behind the ones shown", () => {
  it("count what is past the shown few, and none below it", () => {
    expect(moreOf(2, 3)).toBe(0)
    expect(moreOf(3, 3)).toBe(0)
    expect(moreOf(7, 3)).toBe(4)
  })
})

describe("a pointer arriving at the stack", () => {
  it("is not one that rests where a toast landed, whatever the browser sends", () => {
    const arrival = createArrival()
    arrival.reset()
    arrival.moved({ x: 0, y: 0 })
    expect(arrival.arrived()).toBe(false)
  })

  it("is one that moves after the toast landed", () => {
    const arrival = createArrival()
    arrival.moved({ x: 5, y: 0 })
    arrival.reset()
    expect(arrival.arrived()).toBe(false)
    arrival.moved({ x: 0, y: -3 })
    expect(arrival.arrived()).toBe(true)
  })

  it("is not a hand's jitter, but the small moves that add up", () => {
    const arrival = createArrival()
    arrival.reset()
    arrival.moved({ x: 1, y: 0 })
    arrival.moved({ x: 0, y: 1 })
    expect(arrival.arrived()).toBe(false)
    arrival.moved({ x: 1, y: 0 })
    expect(arrival.arrived()).toBe(true)
  })

  it("must move anew when the next toast lands or the pointer has left", () => {
    const arrival = createArrival()
    arrival.moved({ x: 4, y: 4 })
    expect(arrival.arrived()).toBe(true)
    arrival.reset()
    expect(arrival.arrived()).toBe(false)
  })

  it("counts a focus into the stack", () => {
    const arrival = createArrival()
    arrival.reset()
    arrival.moved(true)
    expect(arrival.arrived()).toBe(true)
  })
})
