import type { ChatRequest } from "@novadeck/core/conversation"
import type { AgentAsk, InboxEntry, Trouble } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import { tagOf } from "./inbox-tag"

const source: InboxEntry["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "moth",
  agent: "claude",
  title: "Title",
  projectName: "Project",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const request = (kind: ChatRequest["kind"], tool: string): InboxEntry => ({
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
const ask = (shape: AgentAsk["shape"], hardToUndo: string | null = null): InboxEntry => ({
  ...base,
  kind: "ask",
  ask: { subject: "s", body: "", details: null, hardToUndo, shape },
})
const trouble = (value: Trouble, stopped = true): InboxEntry => ({
  ...base,
  stopped,
  kind: "trouble",
  trouble: value,
})

describe("A sheet's kind tag", () => {
  it("names what a permission is for by its tool", () => {
    expect(tagOf(request("permission", "Bash")).word).toBe("Command")
    expect(tagOf(request("permission", "exec_command")).word).toBe("Command")
    expect(tagOf(request("permission", "Edit")).word).toBe("Edit")
    expect(tagOf(request("permission", "WebFetch")).word).toBe("Tool")
    expect(tagOf(request("plan", "ExitPlanMode")).word).toBe("Plan")
    expect(tagOf(request("question", "AskUserQuestion")).word).toBe("Question")
  })

  it("calls an agent's ask a question, or the person's move where only they can do it", () => {
    expect(tagOf(ask({ type: "text" })).word).toBe("Question")
    expect(
      tagOf(ask({ type: "action", command: "vercel login", directory: null, doneLabel: "Done" })),
    ).toMatchObject({ word: "Your move", type: "unblock" })
  })

  it("names each kind of trouble, with what its colour says", () => {
    expect(tagOf(trouble({ type: "failed", error: null }))).toMatchObject({
      word: "Error",
      tint: "danger",
    })
    expect(
      tagOf(trouble({ type: "limit", minutes: 300, resetsAt: 0, autoResume: null, evidence: [] })),
    ).toMatchObject({ word: "Limit", tint: "note" })
    expect(tagOf(trouble({ type: "stuck", summary: "", evidence: [], nudge: "" })).word).toBe(
      "Stuck",
    )
    expect(tagOf(trouble({ type: "waits", waits: null, count: 2 }))).toMatchObject({
      word: "Undelivered",
      tint: "note",
    })
  })

  it("tints what waits on the person the same, hard to undo or not", () => {
    expect(tagOf(ask({ type: "text" }, "It drops the table.")).tint).toBe("attention")
    expect(tagOf(ask({ type: "text" })).tint).toBe("attention")
    expect(tagOf(request("permission", "Bash")).tint).toBe("attention")
  })

  it("says how a resolved entry ended, in gray", () => {
    const resolved = (how: "answered" | "dismissed" | "replied" | "ended") =>
      tagOf({ ...ask({ type: "text" }), settled: { how, at: 1 } })
    expect(resolved("answered")).toMatchObject({ word: "Answered", tint: "muted" })
    expect(resolved("dismissed")).toMatchObject({ word: "Dismissed", tint: "muted" })
    expect(resolved("replied")).toMatchObject({ word: "Replied", tint: "muted" })
    expect(resolved("ended")).toMatchObject({ word: "Ended", tint: "muted" })
  })

  it("tints a done report green and what an agent told you plain", () => {
    expect(
      tagOf({
        ...base,
        stopped: false,
        kind: "update",
        update: { type: "done", subject: "s", body: "" },
      }),
    ).toMatchObject({ word: "Update", type: "update", tint: "success" })
    expect(
      tagOf({
        ...base,
        stopped: false,
        kind: "update",
        update: { type: "told", subject: "s", body: "" },
      }).tint,
    ).toBe("ink")
  })
})
