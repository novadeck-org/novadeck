import type { InboxRow } from "@novadeck/core/inbox"
import {
  ClipboardList,
  Flag,
  Gauge,
  ListChecks,
  MailWarning,
  MessageCircleQuestionMark,
  MessageSquareLock,
  MessageSquareText,
  OctagonX,
  Repeat2,
  ShieldQuestionMark,
  SquareTerminal,
} from "lucide-react"

import { describe, expect, it } from "../test"
import { iconOf, tintOf } from "./inbox-icons"

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const request = (kind: "permission" | "question" | "plan", tool: string): InboxRow => ({
  ...base,
  kind: "request",
  request: {
    id: "r",
    kind,
    tool,
    subject: null,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
    askedAt: 0,
  },
})
const ask = (shape: Extract<InboxRow, { kind: "ask" }>["ask"]["shape"]): InboxRow => ({
  ...base,
  kind: "ask",
  ask: { subject: "s", body: "", details: null, hardToUndo: null, shape },
})
const noticed = (trouble: Extract<InboxRow, { kind: "trouble" }>["trouble"]): InboxRow => ({
  ...base,
  kind: "trouble",
  trouble,
})
const update = (type: "done" | "told"): InboxRow => ({
  ...base,
  kind: "update",
  update: { type, subject: "s", body: "" },
})
const held: InboxRow = {
  ...base,
  kind: "held",
  held: {
    threadId: "t",
    from: { handle: "a", title: "A" },
    to: { handle: "b", title: "B" },
    text: "",
    hop: 1,
    heldFor: null,
  },
}
const limit = noticed({
  type: "limit",
  minutes: 300,
  resetsAt: 0,
  autoResume: null,
  evidence: [],
})

describe("An Inbox row's icon and tint", () => {
  it("is one icon for each kind of row", () => {
    expect(iconOf(request("permission", "Bash"))).toBe(ShieldQuestionMark)
    expect(iconOf(request("plan", "ExitPlanMode"))).toBe(ClipboardList)
    expect(iconOf(request("question", "AskUserQuestion"))).toBe(MessageCircleQuestionMark)
    expect(
      iconOf(
        ask({
          type: "options",
          recommend: null,
          options: [{ label: "a", summary: null, details: null, code: null }],
        }),
      ),
    ).toBe(ListChecks)
    expect(
      iconOf(ask({ type: "action", command: "login", directory: null, doneLabel: "Done" })),
    ).toBe(SquareTerminal)
    expect(iconOf(ask({ type: "text" }))).toBe(MessageCircleQuestionMark)
    expect(iconOf(held)).toBe(MessageSquareLock)
    expect(iconOf(limit)).toBe(Gauge)
    expect(iconOf(noticed({ type: "waits", waits: null, count: 1 }))).toBe(MailWarning)
    expect(iconOf(noticed({ type: "failed", error: null }))).toBe(OctagonX)
    expect(iconOf(noticed({ type: "stuck", summary: "", evidence: [], nudge: "" }))).toBe(Repeat2)
    expect(iconOf(update("done"))).toBe(Flag)
    expect(iconOf(update("told"))).toBe(MessageSquareText)
  })

  it("is tinted by what the row wants of the person, whether or not its agent stopped", () => {
    expect(tintOf(request("permission", "Bash"))).toBe("attention")
    expect(tintOf({ ...held, stopped: false })).toBe("attention")
    expect(tintOf(ask({ type: "text" }))).toBe("attention")
    expect(tintOf(limit)).toBe("note")
    expect(tintOf(noticed({ type: "waits", waits: null, count: 1 }))).toBe("note")
    expect(tintOf(noticed({ type: "failed", error: null }))).toBe("danger")
    expect(tintOf({ ...noticed({ type: "failed", error: null }), stopped: false })).toBe("danger")
    expect(tintOf(update("done"))).toBe("success")
    expect(tintOf(update("told"))).toBe("ink")
  })

  it("keeps the icon of a resolved row and turns it gray", () => {
    const resolved: InboxRow = { ...limit, settled: { how: "worked", at: 1 } }
    expect(iconOf(resolved)).toBe(Gauge)
    expect(tintOf(resolved)).toBe("muted")
    expect(tintOf({ ...update("done"), settled: { how: "read", at: 1 } })).toBe("muted")
  })
})
