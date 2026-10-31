import type { InboxRow } from "../inbox"
import { describe, expect, it } from "../test"
import { inboxMarks } from "./marks"

const at = { projectId: "p", workspaceSessionId: "initial", terminalId: "01" }
const now = 1_000_000

const row = (content: Record<string, unknown>, extra: Partial<InboxRow> = {}): InboxRow =>
  ({
    id: `i${Math.random()}`,
    source: { ...at, handle: "fox", agent: "claude", title: "T", projectName: "P" },
    at: now,
    stopped: true,
    seen: false,
    ...content,
    ...extra,
  }) as InboxRow

const ask = (shape: unknown, subject = "Which?"): InboxRow =>
  row({
    kind: "ask",
    ask: { subject, body: "", details: null, hardToUndo: null, shape },
  })
const limit = (resetsAt: number, autoResume: boolean | null): InboxRow =>
  row({
    kind: "trouble",
    trouble: { type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] },
  })
const done = (seen = false): InboxRow =>
  row({ kind: "update", update: { type: "done", subject: "Done", body: "" } }, { seen })

describe("the marks the raw Inbox makes", () => {
  it("is a need with its row's subject, an unblock before an ask", () => {
    expect(inboxMarks([ask({ type: "text" })], at, now)).toEqual({
      need: "ask",
      subject: "Which?",
      dialog: undefined,
    })
    const rows = [
      ask({ type: "text" }),
      ask({ type: "action", command: "x", directory: null, doneLabel: "ok" }, "Log in"),
    ]
    expect(inboxMarks(rows, at, now)).toMatchObject({ need: "unblock", subject: "Log in" })
  })

  it("names the dialog a request stands for, with its subject, and none for a row that is no dialog", () => {
    const request = (kind: "permission" | "plan" | "question", subject: string | null) =>
      row({
        kind: "request",
        request: {
          id: "r",
          kind,
          tool: kind === "plan" ? "ExitPlanMode" : "Bash",
          subject,
          choices: [],
          subagent: false,
          dialog: null,
          answered: false,
        },
      })
    expect(inboxMarks([request("permission", "pnpm test")], at, now)).toMatchObject({
      need: "unblock",
      dialog: "permission",
      subject: "pnpm test",
    })
    expect(inboxMarks([request("plan", "Checkout flow")], at, now)).toMatchObject({
      need: "unblock",
      dialog: "plan",
      subject: "Checkout flow",
    })
    expect(inboxMarks([request("question", null)], at, now)).toMatchObject({
      need: "ask",
      dialog: "question",
      subject: undefined,
    })
    expect(inboxMarks([ask({ type: "text" })], at, now).dialog).toBeUndefined()
  })

  it("reads a settled ask as nothing, beside an open one it is not the subject", () => {
    const settled = row(
      { kind: "ask", ask: { subject: "Old", shape: { type: "text" } } },
      { settled: { how: "dismissed", at: now } },
    )
    expect(inboxMarks([settled], at, now)).toEqual({
      need: undefined,
      subject: undefined,
      dialog: undefined,
    })
    expect(inboxMarks([settled, ask({ type: "text" })], at, now)).toMatchObject({
      need: "ask",
      subject: "Which?",
    })
  })

  it("reads another terminal's rows as nothing", () => {
    const mine = row({ kind: "ask", ask: { subject: "S", shape: { type: "text" } } })
    const other = { ...mine, source: { ...mine.source, terminalId: "02" } }
    expect(inboxMarks([other], at, now)).toEqual({
      need: undefined,
      subject: undefined,
      dialog: undefined,
    })
  })

  it("holds a limit back until it resets, and only then, without auto-resume, needs the person", () => {
    const later = now + 60_000
    expect(inboxMarks([limit(later, false)], at, now).need).toBeUndefined()
    expect(inboxMarks([limit(later, false)], at, later + 1).need).toBe("unblock")
    expect(inboxMarks([limit(later, true)], at, later + 1).need).toBeUndefined()
  })

  it("makes no mark of a done report, seen or not: that stands with the agent", () => {
    expect(inboxMarks([done()], at, now)).toEqual(inboxMarks([], at, now))
    expect(inboxMarks([done(true)], at, now)).toEqual(inboxMarks([], at, now))
  })

  it("says where all a terminal needs is snoozed, with what the snoozed asks", () => {
    const snoozed = { ...ask({ type: "text" }, "Which way?"), snoozed: true as const }
    expect(inboxMarks([snoozed], at, now)).toEqual({
      need: undefined,
      subject: "Which way?",
      snoozed: true,
      snoozedRequests: 0,
    })
    // What isn't snoozed comes first.
    expect(inboxMarks([snoozed, ask({ type: "text" })], at, now)).toEqual({
      need: "ask",
      subject: "Which?",
      dialog: undefined,
    })
    // A snoozed request beside it is counted, so its dialog makes no mark.
    const request = row({
      kind: "request",
      request: {
        id: "r",
        kind: "permission",
        tool: "Bash",
        subject: "ls",
        choices: [],
        subagent: false,
        dialog: null,
        answered: false,
      },
      snoozed: true,
    })
    expect(inboxMarks([request, ask({ type: "text" })], at, now)).toMatchObject({
      need: "ask",
      snoozedRequests: 1,
    })
  })
})
