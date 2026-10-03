import { describe, expect, it } from "../test.js"
import {
  allowClose,
  closeLimit,
  readCloseRequest,
  runnerCloseLimit,
  selfRefusal,
} from "./closes.js"
import { openLimit, runnerOpenLimit } from "./opens.js"

describe("reading a request to close a terminal", () => {
  it("takes the handle of the terminal to close", () => {
    expect(readCloseRequest({ to: "t2" })).toEqual({ ok: true, request: { to: "t2" } })
  })

  it("refuses a request without a handle, or with anything more", () => {
    const refused = {
      ok: false,
      reason: "A close needs `to`, the exact handle of a terminal, and nothing else.",
    }
    expect(readCloseRequest({})).toEqual(refused)
    expect(readCloseRequest({ to: "" })).toEqual(refused)
    expect(readCloseRequest({ to: 2 })).toEqual(refused)
    expect(readCloseRequest({ to: "t".repeat(65) })).toEqual(refused)
    expect(readCloseRequest({ to: "t2", force: true })).toEqual(refused)
  })

  it("tells an agent asking to close its own terminal how to end its session instead", () => {
    expect(selfRefusal("t1")).toBe(
      "t1 is your own terminal, which close_terminal never closes; to end your own session, " +
        "use your harness's own way to exit.",
    )
  })
})

describe("how many terminals agents may close", () => {
  it("allows as many as they may open, from budgets of their own", () => {
    expect(closeLimit).toEqual(openLimit)
    expect(runnerCloseLimit).toEqual(runnerOpenLimit)
  })

  it("allows five a minute, then one more as each falls out of the minute", () => {
    let times: readonly number[] = []
    for (const now of [0, 1_000, 2_000, 3_000, 4_000]) {
      const next = allowClose(times, now)
      expect(next).toBeDefined()
      times = next!
    }
    expect(allowClose(times, 5_000)).toBeUndefined()
    expect(allowClose(times, 59_999)).toBeUndefined()
    expect(allowClose(times, 60_000)).toEqual([1_000, 2_000, 3_000, 4_000, 60_000])
  })

  it("holds the runner to its own limit across every chain", () => {
    const times = Array.from({ length: 20 }, (_, index) => index)
    expect(allowClose(times, 100, runnerCloseLimit)).toBeUndefined()
    expect(allowClose(times.slice(1), 100, runnerCloseLimit)).toHaveLength(20)
  })
})
