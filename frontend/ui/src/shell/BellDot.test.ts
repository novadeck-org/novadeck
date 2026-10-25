import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { BellDot } from "./BellDot"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

// Renders the dot through a run of counts, giving back the ring element after each one.
const ringsThrough = (counts: readonly number[]): (Element | null)[] => {
  const [first, ...rest] = counts
  const { container, rerender, unmount } = render(createElement(BellDot, { count: first! }))
  unmounts.push(unmount)
  const ring = (): Element | null => container.querySelector(".bell-dot-ring")
  return [ring(), ...rest.map((count) => (rerender(createElement(BellDot, { count })), ring()))]
}

describe("the Inbox's dot", () => {
  it("draws nothing while nothing waits", () => {
    const { container, unmount } = render(createElement(BellDot, { count: 0 }))
    unmounts.push(unmount)
    expect(container.innerHTML).toBe("")
  })

  it("stays still when it mounts with items already waiting", () => {
    expect(ringsThrough([2])).toEqual([null])
  })

  it("rings for the first item and each one after, with a fresh ring each time", () => {
    const [none, first, second] = ringsThrough([0, 1, 2])
    expect(none).toBeNull()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it("keeps its last ring, not a new one, while the count holds or falls", () => {
    const [, rang, held, fell] = ringsThrough([1, 2, 2, 1])
    expect(held).toBe(rang)
    expect(fell).toBe(rang)
  })
})
