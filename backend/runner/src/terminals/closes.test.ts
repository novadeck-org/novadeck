import { describe, expect, it } from "../test.js"
import {
  allowClose,
  closeLimit,
  readCloseRequest,
  runnerCloseLimit,
  closeNotice,
  nobodyRefusal,
  waitingRefusal,
} from "./closes.js"
import { openLimit, runnerOpenLimit } from "./opens.js"

describe("reading a request to close a terminal", () => {
  it("takes the handle of the terminal to close", () => {
    expect(readCloseRequest({ to: "fox" })).toEqual({
      ok: true,
      request: { to: "fox" },
    })
    expect(readCloseRequest({ to: "@fox" })).toEqual({
      ok: true,
      request: { to: "fox" },
    })
  })

  it("refuses a request without a handle, or with anything more", () => {
    const refused = {
      ok: false,
      reason: "A close needs `to`, the exact handle of a terminal, and nothing else.",
    }
    expect(readCloseRequest({})).toEqual(refused)
    expect(readCloseRequest({ to: "" })).toEqual(refused)
    expect(readCloseRequest({ to: 2 })).toEqual(refused)
    expect(readCloseRequest({ to: "t".repeat(66) })).toEqual(refused)
    expect(readCloseRequest({ to: "fox", force: true })).toEqual(refused)
  })
})

describe("what an agent is told about a close that waits for the user", () => {
  it("refuses an ask while none is open to ask, or one already waits", () => {
    expect(nobodyRefusal).toBe("Novadeck isn't open to ask the user, so nothing closed.")
    expect(waitingRefusal("fox")).toBe(
      "@fox is already waiting for the user's confirmation to close.",
    )
  })

  it("tells the outcome of the user's answer, or of an ask that ended without it", () => {
    expect(closeNotice.confirmed("fox", "api", "Codex")).toBe(
      "Novadeck: automatic notice, not from the user: The user confirmed closing @fox · api, which ran Codex, and it is closed. Messages " +
        "waiting for it never arrive.",
    )
    expect(closeNotice.confirmed("fox", "api", undefined)).toContain("closing @fox · api, and")
    expect(closeNotice.declined("fox", "api")).toBe(
      "Novadeck: automatic notice, not from the user: The user kept @fox · api open: it was not closed.",
    )
    expect(closeNotice.vanished("fox")).toBe(
      "Novadeck: automatic notice, not from the user: @fox closed, or its shell ended, before the user answered, so there is nothing left to confirm.",
    )
    expect(closeNotice.gone("fox")).toContain("Nothing closed: Novadeck's window went away")
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
