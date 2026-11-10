import { describe, expect, it } from "../test.js"
import { keptTurns, TurnLog, type LoggedTurn } from "./turn-log.js"

const turn = (at: number, fields: Partial<LoggedTurn> = {}): LoggedTurn => ({
  projectId: "p",
  agent: "claude",
  sessionId: "s",
  at,
  from: null,
  outcome: "completed",
  reply: `reply ${at}`,
  error: null,
  ...fields,
})

describe("a terminal's latest finished turns", () => {
  it("are kept oldest first, the same end once, the latest few", () => {
    const log = new TurnLog()
    for (let at = keptTurns + 2; at > 0; at -= 1) log.record("A", turn(at))
    log.record("A", turn(5, { reply: "amended" }))
    const kept = log.of("A", { agent: "claude", sessionId: "s" })
    expect(kept.map(({ at }) => at)).toEqual(Array.from({ length: keptTurns }, (_, i) => i + 3))
    expect(kept.find(({ at }) => at === 5)?.reply).toBe("amended")
  })

  it("are read by session, and forgotten once dropped, closed or their project removed", () => {
    const log = new TurnLog()
    log.record("A", turn(1))
    log.record("A", turn(2, { sessionId: "other" }))
    log.record("B", turn(3, { projectId: "q" }))
    expect(log.of("A", { agent: "claude", sessionId: "s" }).map(({ at }) => at)).toEqual([1])
    log.drop("A", 1)
    expect(log.of("A", { agent: "claude", sessionId: "s" })).toEqual([])
    log.retain(() => true, "q")
    expect(log.of("B", { agent: "claude", sessionId: "s" })).toEqual([])
    log.retain((id) => id !== "A")
    expect(log.of("A", { agent: "claude", sessionId: "other" })).toEqual([])
  })

  it("keep a turn's start when it is stored again without one, and take amends", () => {
    const log = new TurnLog()
    log.record("A", turn(5, { from: 2 }))
    log.record("A", turn(5, { reply: "filled in" }))
    // Its Inbox row may be gone, read: the log still changes with the end.
    log.amend("A", 5, { outcome: "failed", reply: null, error: "API error" })
    log.amend("A", 9, { outcome: "failed", reply: null, error: "none kept" })
    expect(log.of("A", { agent: "claude", sessionId: "s" })).toEqual([
      turn(5, { from: 2, outcome: "failed", reply: null, error: "API error" }),
    ])
  })
})
