import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { BellDot } from "./BellDot"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

// Renders the dot through a run of the bell's ring counts, giving back the ring element after
// each one.
const ringsThrough = (run: readonly number[]): (Element | null)[] => {
  const [first, ...rest] = run
  const { container, rerender, unmount } = render(createElement(BellDot, { rings: first! }))
  unmounts.push(unmount)
  const ring = (): Element | null => container.querySelector(".bell-dot-ring")
  return [ring(), ...rest.map((rings) => (rerender(createElement(BellDot, { rings })), ring()))]
}

describe("the Inbox's dot", () => {
  it("stays still for the rings the bell rang before it appeared", () => {
    expect(ringsThrough([3])).toEqual([null])
  })

  it("rings for each ring after it appeared, with a fresh ring each time", () => {
    // It appears with the item, and the bell rings for it once its grace has passed.
    const [still, first, second] = ringsThrough([4, 5, 6])
    expect(still).toBeNull()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it("keeps its last ring while the bell rings nothing new", () => {
    const [, rang, held] = ringsThrough([0, 1, 1])
    expect(held).toBe(rang)
  })
})
