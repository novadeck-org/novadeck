import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach } from "vitest"

import { describe, expect, it } from "../test"
import { BellDot } from "./BellDot"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

// Renders the dot through a run of `latest`s, giving back the ring element after each one.
const ringsThrough = (run: readonly (number | undefined)[]): (Element | null)[] => {
  const [first, ...rest] = run
  const { container, rerender, unmount } = render(createElement(BellDot, { latest: first }))
  unmounts.push(unmount)
  const ring = (): Element | null => container.querySelector(".bell-dot-ring")
  return [ring(), ...rest.map((latest) => (rerender(createElement(BellDot, { latest })), ring()))]
}

describe("the Inbox's dot", () => {
  it("draws nothing while nothing waits", () => {
    const { container, unmount } = render(createElement(BellDot, { latest: undefined }))
    unmounts.push(unmount)
    expect(container.innerHTML).toBe("")
  })

  it("stays still when it mounts with items already waiting", () => {
    expect(ringsThrough([Date.now()])).toEqual([null])
  })

  it("stays still while the Inbox fills in with items from before it mounted", () => {
    const hourAgo = Date.now() - 3_600_000
    expect(ringsThrough([undefined, hourAgo, hourAgo + 1])).toEqual([null, null, null])
  })

  it("rings for the first new item and each newer one, with a fresh ring each time", () => {
    const now = Date.now()
    const [none, first, second] = ringsThrough([undefined, now, now + 1])
    expect(none).toBeNull()
    expect(first).not.toBeNull()
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it("keeps its last ring, not a new one, when the newest item leaves", () => {
    const now = Date.now()
    const [, rang, older] = ringsThrough([undefined, now + 1, now])
    expect(older).toBe(rang)
  })
})
