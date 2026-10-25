import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { BellDot } from "./BellDot"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

type Props = { shown: boolean; rings: number }

// Renders the dot through a run of props, giving back the ring element after each one.
const ringsThrough = (run: readonly Props[]): (Element | null)[] => {
  const [first, ...rest] = run
  const { container, rerender, unmount } = render(createElement(BellDot, first!))
  unmounts.push(unmount)
  const ring = (): Element | null => container.querySelector(".bell-dot-ring")
  return [ring(), ...rest.map((props) => (rerender(createElement(BellDot, props)), ring()))]
}

describe("the Inbox's dot", () => {
  it("draws nothing while nothing waits", () => {
    const { container, unmount } = render(createElement(BellDot, { shown: false, rings: 3 }))
    unmounts.push(unmount)
    expect(container.innerHTML).toBe("")
  })

  it("stays still for the rings the bell rang before it mounted", () => {
    expect(ringsThrough([{ shown: true, rings: 3 }])).toEqual([null])
  })

  it("rings for each ring after, with a fresh ring each time", () => {
    const [none, first, second] = ringsThrough([
      { shown: false, rings: 0 },
      { shown: true, rings: 1 },
      { shown: true, rings: 2 },
    ])
    expect(none).toBeNull()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it("rings for the first item when it mounts with the item, before the bell rings for it", () => {
    // As the Zen dock does: its bell shows with the badge, and the bell rings after the grace.
    const [still, rang] = ringsThrough([
      { shown: true, rings: 4 },
      { shown: true, rings: 5 },
    ])
    expect(still).toBeNull()
    expect(rang).not.toBeNull()
  })

  it("keeps its last ring while the bell rings nothing new", () => {
    const [, rang, held] = ringsThrough([
      { shown: false, rings: 0 },
      { shown: true, rings: 1 },
      { shown: true, rings: 1 },
    ])
    expect(held).toBe(rang)
  })
})
