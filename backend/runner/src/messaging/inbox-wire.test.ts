import { agentActivity, inboxEntry, maxTurnFiles } from "@novadeck/protocol"
import { describe, expect, it } from "vitest"

const base = {
  id: "00000000-0000-4000-8000-000000000001",
  terminalId: "00000000-0000-4000-8000-000000000002",
  projectId: "00000000-0000-4000-8000-000000000003",
  workspaceSessionId: "00000000-0000-4000-8000-000000000004",
  agent: "claude" as const,
  sessionId: "s",
  handle: "h",
  at: 1,
}
const turn = {
  kind: "turn" as const,
  outcome: "completed" as const,
  reply: "done",
  error: null,
  files: [],
}

describe("the turn entry on the wire", () => {
  it("accepts a completed and a failed turn", () => {
    expect(inboxEntry.safeParse({ ...base, content: turn }).success).toBe(true)
    expect(
      inboxEntry.safeParse({
        ...base,
        content: { ...turn, outcome: "failed", reply: null, error: "boom" },
      }).success,
    ).toBe(true)
  })

  it("refuses other outcomes, unknown keys and too many files", () => {
    for (const content of [
      { ...turn, outcome: "interrupted" },
      { ...turn, extra: 1 },
      { ...turn, files: Array.from({ length: maxTurnFiles + 1 }, (_, i) => `/f${i}`) },
      { ...turn, reply: "" },
    ]) {
      expect(inboxEntry.safeParse({ ...base, content }).success).toBe(false)
    }
  })
})

describe("a settled ask on the wire", () => {
  const ask = {
    kind: "ask" as const,
    ask: { subject: "S", body: "B", details: null, hardToUndo: null, shape: { type: "text" } },
  }
  it("takes how and when it ended, and refuses other causes and keys", () => {
    for (const how of ["dismissed", "withdrawn", "replied"])
      expect(inboxEntry.safeParse({ ...base, content: ask, settled: { how, at: 2 } }).success).toBe(
        true,
      )
    for (const settled of [
      { how: "answered", at: 2 },
      { how: "dismissed" },
      { how: "dismissed", at: 2, extra: 1 },
    ])
      expect(inboxEntry.safeParse({ ...base, content: ask, settled }).success).toBe(false)
  })
})

describe("lastTurn.limited", () => {
  const lastTurn = {
    outcome: "failed" as const,
    reply: null,
    at: 1,
    error: null,
    limit: null,
    files: [],
  }
  const summaryShape = agentActivity.shape.lastTurn.unwrap()

  it("is optional and only ever true", () => {
    expect(summaryShape.safeParse(lastTurn).success).toBe(true)
    expect(summaryShape.safeParse({ ...lastTurn, limited: true }).success).toBe(true)
    expect(summaryShape.safeParse({ ...lastTurn, limited: false }).success).toBe(false)
  })
})
