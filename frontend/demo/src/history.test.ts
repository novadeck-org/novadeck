import { afterEach, beforeEach, vi } from "vitest"

import { createDemoHistory, restoreMs } from "./history"
import { context, describe, expect, it } from "./test"

const now = new Date(2026, 10, 6, 18, 0).getTime()

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("the demo's History", () => {
  it("has a row for every state a row can be in", () => {
    const rows = createDemoHistory(now).history.state.getSnapshot().rows
    const states = rows.map((row) => row.availability.state)
    for (const state of ["ready", "gone", "disconnected", "open"]) expect(states).toContain(state)
    expect(rows.filter((row) => row.agent === null).length).toBeGreaterThan(0)
    expect(rows.map((row) => row.closedAt)).toEqual(
      rows.map((row) => row.closedAt).toSorted((a, b) => b - a),
    )
  })

  it("lists one project's rows", async () => {
    const { history } = createDemoHistory(now)
    expect((await history.list("storefront")).length).toBeGreaterThan(5)
    expect(await history.list("docs-site")).toEqual([])
  })

  context("when a row is restored", () => {
    it("shows it restoring, then drops it once confirmed", () => {
      const demo = createDemoHistory(now)
      const id = demo.history.state.getSnapshot().rows[0]!.id
      demo.restore(id)
      expect(demo.history.state.getSnapshot().rows[0]!.availability).toEqual({ state: "restoring" })
      vi.advanceTimersByTime(restoreMs)
      expect(demo.history.state.getSnapshot().rows.some((row) => row.id === id)).toBe(false)
    })
  })

  context("when a terminal is closed", () => {
    it("keeps it as the newest row of its project, with its agent", () => {
      const demo = createDemoHistory(now)
      demo.keep(
        "storefront",
        {
          id: "x",
          name: "Tests",
          directory: "~/p",
          command: "codex",
          process: "codex",
          state: "idle",
          handle: "owl",
        },
        now,
      )
      expect(demo.history.state.getSnapshot().rows[0]).toMatchObject({
        title: "Tests",
        agent: "codex",
        handle: "owl",
        closedAt: now,
        availability: { state: "ready" },
      })
    })
  })
})
