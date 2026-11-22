import type { InboxEntry } from "../inbox"
import { describe, expect, it } from "../test"
import { inboxMarks } from "./marks"

const at = { projectId: "p", workspaceSessionId: "initial", terminalId: "01" }
const now = 1_000_000

const entry = (content: Record<string, unknown>, extra: Partial<InboxEntry> = {}): InboxEntry =>
  ({
    id: `i${Math.random()}`,
    source: { ...at, handle: "fox", agent: "claude", title: "T", projectName: "P" },
    at: now,
    stopped: true,
    seen: false,
    ...content,
    ...extra,
  }) as InboxEntry

const ask = (shape: unknown, subject = "Which?"): InboxEntry =>
  entry({
    kind: "ask",
    ask: { subject, body: "", details: null, hardToUndo: null, shape },
  })
const limit = (resetsAt: number, autoResume: boolean | null): InboxEntry =>
  entry({
    kind: "trouble",
    trouble: { type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] },
  })
const done = (seen = false): InboxEntry =>
  entry({ kind: "update", update: { type: "done", subject: "Done", body: "" } }, { seen })

describe("the marks the landed Inbox makes", () => {
  it("makes none for an ask the landing rule holds back, and does once it counts", () => {
    const held = { ...ask({ type: "text" }), heldBack: true as const }
    expect(inboxMarks([held], at, now)).toEqual({
      need: undefined,
      subject: undefined,
      dialog: undefined,
    })
    expect(inboxMarks([ask({ type: "text" })], at, now).need).toBe("ask")
  })

  it("marks the terminal by its other entries while one ask is held", () => {
    const held = { ...ask({ type: "text" }), heldBack: true as const }
    expect(
      inboxMarks(
        [held, ask({ type: "action", command: "x", directory: null, doneLabel: "ok" })],
        at,
        now,
      ).need,
    ).toBe("unblock")
  })

  it("is a need with its entry's subject, an unblock before an ask", () => {
    expect(inboxMarks([ask({ type: "text" })], at, now)).toEqual({
      need: "ask",
      subject: "Which?",
      dialog: undefined,
    })
    const entries = [
      ask({ type: "text" }),
      ask({ type: "action", command: "x", directory: null, doneLabel: "ok" }, "Log in"),
    ]
    expect(inboxMarks(entries, at, now)).toMatchObject({ need: "unblock", subject: "Log in" })
  })

  it("names the dialog a request stands for, with its subject, and none for an entry that is no dialog", () => {
    const request = (kind: "permission" | "plan" | "question", subject: string | null) =>
      entry({
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
    const settled = entry(
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

  it("reads another terminal's entries as nothing", () => {
    const mine = entry({ kind: "ask", ask: { subject: "S", shape: { type: "text" } } })
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
    const request = entry({
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
