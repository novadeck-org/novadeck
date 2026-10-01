import { setImmediate as tick } from "node:timers/promises"

import { vi } from "vitest"

import { describe, expect, it } from "../test.js"
import { coalesced } from "./coalesce.js"

describe("coalesced changes", () => {
  it("run once per key per tick, however many changes came", async () => {
    const runs: string[] = []
    const changed = coalesced((key) => runs.push(key), "failed:")
    for (let index = 0; index < 100; index++) changed("a")
    changed("b")
    changed("b")
    expect(runs).toEqual([])
    await tick()
    expect(runs.toSorted()).toEqual(["a", "b"])
    changed("a")
    await tick()
    expect(runs).toHaveLength(3)
  })

  it("log a run that fails, at once or later, and run the next key all the same", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const runs: string[] = []
    const broken = new Error("broken")
    const changed = coalesced((key) => {
      runs.push(key)
      if (key === "throws") throw broken
      if (key === "rejects") return Promise.reject(broken)
      return undefined
    }, "Looking failed:")
    changed("throws")
    changed("rejects")
    changed("next")
    await tick()
    await tick()
    expect(runs).toEqual(["throws", "rejects", "next"])
    expect(error.mock.calls).toEqual([
      ["Looking failed:", broken],
      ["Looking failed:", broken],
    ])
    error.mockRestore()
  })
})
