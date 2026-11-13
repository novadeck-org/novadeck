import { describe, expect, it } from "../test.js"
import { historyHost, type HistoryParts } from "./history-host.js"
import type { Record } from "./record.js"

const terminal = (handle: string, closed: boolean): Record =>
  ({
    summary: { id: `t-${handle}`, handle, sessionId: "s1", ledBy: null },
    closed,
    bound: null,
  }) as unknown as Record

const hostOf = (
  records: Record[],
  claimant: string | undefined,
  resting?: { handle: string; terminalId: string },
) =>
  historyHost({
    resting: () => resting,
    records: new Map(records.map((record) => [record.summary.id, record])),
    claims: { claimant: () => claimant },
    saves: { terminals: () => [] },
  } as unknown as HistoryParts)

describe("who holds a session for History", () => {
  it("names a running terminal that claimed it to resume", () => {
    const host = hostOf([terminal("moth", false)], "t-moth")
    expect(host.holder("claude", "c1")).toEqual({ handle: "moth", terminalId: "t-moth" })
  })

  it("does not name a closed terminal, whose claim lasts until its shell ends", () => {
    const host = hostOf([terminal("moth", true)], "t-moth")
    expect(host.holder("claude", "c1")).toBeUndefined()
  })
})

describe("a sleeper holding a session for History", () => {
  it("is named, though it has no record, and before any claim", () => {
    const sleeper = { handle: "fox", terminalId: "t-fox" }
    expect(hostOf([], "t-moth", sleeper).holder("claude", "c1")).toEqual(sleeper)
  })
})
