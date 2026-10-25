import { agentActivity, inboxLetter } from "@novadeck/protocol"
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
  gist: null,
  error: null,
  files: [],
}

describe("the turn letter on the wire", () => {
  it("accepts a completed and a failed turn", () => {
    expect(inboxLetter.safeParse({ ...base, content: turn }).success).toBe(true)
    expect(
      inboxLetter.safeParse({
        ...base,
        content: { ...turn, outcome: "failed", reply: null, error: "boom" },
      }).success,
    ).toBe(true)
  })

  it("refuses other outcomes, unknown keys and too many files", () => {
    for (const content of [
      { ...turn, outcome: "interrupted" },
      { ...turn, extra: 1 },
      { ...turn, files: Array.from({ length: 17 }, (_, i) => `/f${i}`) },
      { ...turn, reply: "" },
    ]) {
      expect(inboxLetter.safeParse({ ...base, content }).success).toBe(false)
    }
  })
})

describe("lastTurn.limited", () => {
  const lastTurn = {
    outcome: "failed" as const,
    reply: null,
    at: 1,
    gist: null,
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
