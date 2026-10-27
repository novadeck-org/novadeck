import type { ChatRequest } from "@novadeck/core/conversation"
import type { AgentAsk, InboxRow, Trouble } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import { tagOf } from "./inbox-tag"

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

const request = (kind: ChatRequest["kind"], tool: string): InboxRow => ({
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
  },
})
const ask = (shape: AgentAsk["shape"], hardToUndo: string | null = null): InboxRow => ({
  ...base,
  kind: "ask",
  ask: { subject: "s", body: "", details: null, hardToUndo, shape },
})
const trouble = (value: Trouble, stopped = true): InboxRow => ({
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

  it("names each kind of trouble, red only for what stopped on a failure", () => {
    expect(tagOf(trouble({ type: "failed", error: null }))).toMatchObject({
      word: "Error",
      tone: "urgent",
    })
    expect(
      tagOf(trouble({ type: "limit", minutes: 300, resetsAt: 0, autoResume: null, evidence: [] })),
    ).toMatchObject({ word: "Limit", tone: "waiting" })
    expect(tagOf(trouble({ type: "stuck", summary: "", evidence: [], nudge: "" })).word).toBe(
      "Stuck",
    )
    expect(tagOf(trouble({ type: "waits", waits: null, count: 2 }))).toMatchObject({
      word: "Undelivered",
      tone: "waiting",
    })
  })

  it("is red for an ask whose answer is hard to undo, and never guesses one for a permission", () => {
    expect(tagOf(ask({ type: "text" }, "It drops the table.")).tone).toBe("urgent")
    expect(tagOf(ask({ type: "text" })).tone).toBe("waiting")
    expect(tagOf(request("permission", "Bash")).tone).toBe("waiting")
  })

  it("is Withdrawn and quiet for a settled ask, however it settled", () => {
    for (const how of ["withdrawn", "dismissed", "replied"] as const)
      expect(tagOf({ ...ask({ type: "text" }), settled: { how, at: 1 } })).toMatchObject({
        word: "Withdrawn",
        tone: "quiet",
      })
  })

  it("is quiet for an update", () => {
    expect(
      tagOf({
        ...base,
        stopped: false,
        kind: "update",
        update: { type: "done", subject: "s", body: "" },
      }),
    ).toMatchObject({ word: "Update", type: "update", tone: "quiet" })
  })
})
