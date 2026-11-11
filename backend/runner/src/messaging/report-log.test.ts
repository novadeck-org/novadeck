import { isAgentName } from "@novadeck/protocol"

import { describe, expect, it } from "../test.js"
import {
  keptReports,
  keptTurns,
  reportOf,
  ReportLog,
  storedReport,
  type LoggedReport,
} from "./report-log.js"

const row = (id: string, at: number, fields: Partial<LoggedReport> = {}): LoggedReport => ({
  id,
  projectId: "p",
  terminalId: "A",
  agent: "claude",
  sessionId: "s",
  kind: "done",
  at,
  from: null,
  subject: `Done ${at}`,
  outcome: null,
  text: null,
  pr: null,
  ...fields,
})

const turn = (id: string, at: number, fields: Partial<LoggedReport> = {}) =>
  row(id, at, { kind: "turn", subject: null, outcome: "completed", text: `reply ${at}`, ...fields })

const entry = (content: unknown) => ({
  id: "e-1",
  projectId: "p",
  terminalId: "A",
  workspaceSessionId: "w",
  agent: "codex",
  sessionId: "s",
  handle: "moth",
  at: 7,
  content,
})

describe("the rows a report log makes of Inbox entries", () => {
  it("makes a report's with its subject, the pull request it names and its body apart", () => {
    const made = reportOf(
      entry({
        kind: "done",
        subject: "Merged",
        body: "see https://github.com/o/r/pull/9",
      }) as never,
    )
    expect(made.row).toMatchObject({
      id: "e-1",
      agent: "codex",
      kind: "done",
      at: 7,
      subject: "Merged",
      pr: "https://github.com/o/r/pull/9",
      outcome: null,
    })
    expect(made.body).toBe("see https://github.com/o/r/pull/9")
    expect(JSON.stringify(made.row)).not.toContain("see https")
  })

  it("makes a turn's with the reply of a completed one and the error of a failed one", () => {
    const content = { kind: "turn", reply: "All done", error: "boom", files: [] }
    expect(reportOf(entry({ ...content, outcome: "completed" }) as never, 3).row).toMatchObject({
      kind: "turn",
      from: 3,
      outcome: "completed",
      text: "All done",
    })
    expect(reportOf(entry({ ...content, outcome: "failed" }) as never).row).toMatchObject({
      outcome: "failed",
      text: "boom",
    })
  })

  it("reads a stored record by the Inbox's rules, so a migration never fails on one", () => {
    const stored = (record: unknown) => storedReport(record, isAgentName)
    expect(stored(entry({ kind: "tell", subject: "Hi", body: "" }))?.row.kind).toBe("tell")
    // Content that no longer parses, an agent this build doesn't know, and no record at all.
    expect(stored(entry({ kind: "tell", subject: "", body: "" }))).toBeUndefined()
    expect(stored({ ...entry({ kind: "tell", subject: "Hi", body: "" }), agent: "future" })).toBe(
      undefined,
    )
    expect(stored({ ...entry({ kind: "tell", subject: "Hi", body: "" }), at: "soon" })).toBe(
      undefined,
    )
    expect(stored(null)).toBeUndefined()
    expect(stored("text")).toBeUndefined()
    // A turn is clamped, not dropped, for a limit that tightened.
    expect(
      stored(entry({ kind: "turn", outcome: "odd", reply: "r", extra: 1 }))?.row,
    ).toMatchObject({
      outcome: "failed",
    })
  })
})

describe("what a report log keeps of an agent session", () => {
  it("lists a session's rows oldest first, and reads its latest tell and done", () => {
    const log = new ReportLog([
      row("d2", 20),
      row("t1", 15, { kind: "tell", subject: "Update" }),
      row("d1", 10),
      row("x", 12, { sessionId: "other" }),
    ])
    expect(log.of("claude", "s").map(({ id }) => id)).toEqual(["d1", "t1", "d2"])
    expect(log.reports("claude", "s")).toEqual({
      tell: { subject: "Update", at: 15 },
      done: { subject: "Done 20", at: 20 },
    })
    expect(log.reports("codex", "s")).toEqual({ tell: null, done: null })
  })

  it("is read by session, not terminal, so a restore in a new terminal finds what came before", () => {
    const log = new ReportLog([row("d1", 10, { terminalId: "old" })])
    expect(log.of("claude", "s")).toHaveLength(1)
    expect(log.turnAt("old", 10)).toBeUndefined()
  })

  it("holds rows past what a session keeps for the caller to let go, oldest first", () => {
    const rows = [
      ...Array.from({ length: keptReports + 2 }, (_, index) => row(`d${index}`, index + 1)),
      ...Array.from({ length: keptTurns + 1 }, (_, index) => turn(`t${index}`, 100 + index)),
    ]
    const log = new ReportLog(rows)
    expect(log.excess("claude", "s")).toEqual(["t0", "d0", "d1"])
    log.remove(log.excess("claude", "s"))
    expect(log.excess("claude", "s")).toEqual([])
  })

  it("moves the rows picked to another session, and forgets a project's or the unwanted", () => {
    const log = new ReportLog([row("a", 1), row("b", 2), row("c", 3, { projectId: "q" })])
    expect(log.rekey((each) => each.id === "a", "fixed").map(({ id }) => id)).toEqual(["a"])
    expect(log.of("claude", "fixed").map(({ id }) => id)).toEqual(["a"])
    expect(log.of("claude", "s").map(({ id }) => id)).toEqual(["b", "c"])
    expect(log.forgetProject("q")).toEqual(["c"])
    expect(log.retain((each) => each.id === "a")).toEqual(["b"])
    expect(log.get("b")).toBeUndefined()
  })

  it("quotes a report's body only when asked for, and reads each report's once", () => {
    const log = new ReportLog([row("d1", 1), turn("t1", 2), row("a1", 3, { kind: "ask" })])
    const asked: (readonly string[])[] = []
    const plain = log.happenings("claude", "s")
    expect(plain[0]).toMatchObject({ kind: "done", body: null })
    const full = log.happenings("claude", "s", (ids) => {
      asked.push(ids)
      return new Map([["d1", "at length"]])
    })
    expect(full[0]).toMatchObject({ kind: "done", subject: "Done 1", body: "at length" })
    expect(full.map(({ kind }) => kind)).toEqual(["done", "turn", "asked"])
    expect(asked).toEqual([["d1"]])
  })
})
