import { terminalFixture } from "@novadeck/core/testing"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"
import { afterEach, beforeEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { WaitingBranches } from "./TabWaiting"

const unmounts: (() => void)[] = []
afterEach(() => unmounts.splice(0).forEach((unmount) => unmount()))

const trailOf = (wakeAt: number): string | undefined => {
  const terminal = terminalFixture(1, "~/p")
  const { container, unmount } = render(
    createElement(WaitingBranches, {
      terminal,
      waiting: { jobs: [], wake: { at: wakeAt, reason: "Check the deploy" } },
    }),
  )
  unmounts.push(unmount)
  return container.querySelector(".terminal-tab-wait-trail")?.textContent ?? undefined
}

describe("a waiting tab's wake-up row", () => {
  const now = new Date(2026, 9, 24, 14, 20).getTime()
  beforeEach(() => void vi.useFakeTimers({ now }))
  afterEach(() => void vi.useRealTimers())

  it("says the clock today, and a day off short enough to leave its label room", () => {
    expect(trailOf(new Date(2026, 9, 24, 16, 5).getTime())).toBe("16:05")
    const weekday = new Date(2026, 9, 26).toLocaleDateString(undefined, { weekday: "short" })
    // The weekday alone, or the days to it, never the clock after them: that clipped the label's room.
    expect(trailOf(new Date(2026, 9, 26, 9, 30).getTime())).toBe(weekday)
    expect(trailOf(new Date(2026, 9, 31, 8, 51).getTime())).toBe("in 7d")
  })
})
