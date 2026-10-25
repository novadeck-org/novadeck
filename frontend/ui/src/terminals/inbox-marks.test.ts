import type { InboxItem } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import { inboxMarks } from "./inbox-marks"

const at = { projectId: "p", workspaceSessionId: "initial", terminalId: "01" }
const now = 1_000_000

const item = (content: Record<string, unknown>, extra: Partial<InboxItem> = {}): InboxItem =>
  ({
    id: `i${Math.random()}`,
    source: { ...at, handle: "fox", agent: "claude", title: "T", projectName: "P" },
    at: now,
    stopped: true,
    seen: false,
    ...content,
    ...extra,
  }) as InboxItem

const ask = (shape: unknown, subject = "Which?"): InboxItem =>
  item({
    kind: "ask",
    ask: { subject, body: "", details: null, hardToUndo: null, shape },
  })
const limit = (resetsAt: number, autoResume: boolean | null): InboxItem =>
  item({
    kind: "trouble",
    trouble: { type: "limit", minutes: 300, resetsAt, autoResume, evidence: [] },
  })
const done = (seen = false): InboxItem =>
  item({ kind: "update", update: { type: "done", subject: "Done", body: "" } }, { seen })

describe("the marks the raw Inbox makes", () => {
  it("is a need with its item's subject, an unblock before an ask", () => {
    expect(inboxMarks([ask({ type: "text" })], at, now)).toEqual({
      need: "ask",
      done: false,
      subject: "Which?",
    })
    const items = [
      ask({ type: "text" }),
      ask({ type: "action", command: "x", directory: null, doneLabel: "ok" }, "Log in"),
    ]
    expect(inboxMarks(items, at, now)).toMatchObject({ need: "unblock", subject: "Log in" })
  })

  it("reads another terminal's items as nothing", () => {
    const mine = item({ kind: "ask", ask: { subject: "S", shape: { type: "text" } } })
    const other = { ...mine, source: { ...mine.source, terminalId: "02" } }
    expect(inboxMarks([other], at, now)).toEqual({
      need: undefined,
      done: false,
      subject: undefined,
    })
  })

  it("holds a limit back until it resets, and only then, without auto-resume, needs the person", () => {
    const later = now + 60_000
    expect(inboxMarks([limit(later, false)], at, now).need).toBeUndefined()
    expect(inboxMarks([limit(later, false)], at, later + 1).need).toBe("unblock")
    expect(inboxMarks([limit(later, true)], at, later + 1).need).toBeUndefined()
  })

  it("knows a done report unseen, and not once seen", () => {
    expect(inboxMarks([done()], at, now).done).toBe(true)
    expect(inboxMarks([done(true)], at, now).done).toBe(false)
  })
})
