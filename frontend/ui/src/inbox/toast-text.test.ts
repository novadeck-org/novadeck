import type { InboxRow } from "@novadeck/core/inbox"

import { describe, expect, it } from "../test"
import { toastText } from "./toast-text"

const source: InboxRow["source"] = {
  projectId: "p",
  workspaceSessionId: "s",
  terminalId: "t",
  handle: "crow",
  agent: "claude",
  title: "Typecheck sweep",
  projectName: "novadeck",
}
const base = { id: "i", source, at: 0, stopped: true, seen: false }

const permission = (tool: string, subject: string | null): InboxRow => ({
  ...base,
  kind: "request",
  request: {
    id: "r",
    kind: "permission",
    tool,
    subject,
    choices: [],
    subagent: false,
    dialog: null,
    answered: false,
  },
})

describe("A toast's words", () => {
  it("shows a command the agent wants to run as one, under the handle that says so", () => {
    const text = toastText(permission("Bash", "pnpm typecheck"), 5_000)
    expect(text).toMatchObject({
      handle: "crow",
      said: "wants to run a command",
      command: "pnpm typecheck",
      type: "unblock",
      tone: "waiting",
      age: "now",
      title: "Typecheck sweep",
      project: "novadeck",
    })
  })

  it("reads an edit as a sentence, its file as code without the backticks", () => {
    const text = toastText(permission("Edit", "src/a.ts"), 0)
    expect(text.command).toBeNull()
    expect(text.said).toBe("wants to edit a file")
    expect(text.subject).toBe("Edit src/a.ts?")
  })

  it("ages as the Inbox's rows do", () => {
    expect(toastText(permission("Bash", "ls"), 3 * 60_000).age).toBe("3m")
  })

  it("gives what Novadeck says itself no handle, and its own name", () => {
    const text = toastText(
      { ...base, kind: "trouble", trouble: { type: "failed", error: null } },
      0,
    )
    expect(text).toMatchObject({
      handle: undefined,
      novadeck: true,
      said: "Novadeck noticed",
      type: "trouble",
      tone: "urgent",
      subject: "Its turn ended in an error",
    })
  })
})
