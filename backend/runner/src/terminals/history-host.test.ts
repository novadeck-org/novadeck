import { describe, expect, it } from "../test.js"
import { historyHost, type HistoryParts } from "./history-host.js"
import type { Record } from "./record.js"

const terminal = (handle: string, closed: boolean): Record =>
  ({ summary: { id: `t-${handle}`, handle }, closed, bound: null }) as unknown as Record

const hostOf = (records: Record[], claimant: string | undefined) =>
  historyHost({
    records: new Map(records.map((record) => [record.summary.id, record])),
    claims: { claimant: () => claimant },
  } as unknown as HistoryParts)

describe("who holds a session for History", () => {
  it("names a running terminal that claimed it to resume", () => {
    const host = hostOf([terminal("moth", false)], "t-moth")
    expect(host.holder("claude", "c1")).toBe("moth")
  })

  it("does not name a closed terminal, whose claim lasts until its shell ends", () => {
    const host = hostOf([terminal("moth", true)], "t-moth")
    expect(host.holder("claude", "c1")).toBeUndefined()
  })
})
