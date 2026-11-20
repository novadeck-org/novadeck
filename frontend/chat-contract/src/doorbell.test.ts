import { agentContext } from "@novadeck/core/agents/steps"
import type { ChatItem } from "@novadeck/core/conversation"
import { doorbellLine, replyLine, startLine } from "@novadeck/harness-core/prompts"

import { describe, expect, it } from "./test"

// Core leaves Novadeck's own doorbell out of the person's words with a copy of
// harness-core's patterns, as it may not import harness-core: this keeps the copy equal to
// the lines the doorbell types.

let count = 0
const user = (text: string, at: number): ChatItem => ({
  id: `i${++count}`,
  at,
  role: "user",
  kind: "text",
  text,
  truncated: false,
  tool: null,
  call: null,
  author: null,
  run: null,
  outcome: null,
  scripted: false,
  interrupted: false,
  ring: null,
})

const said = (line: string) =>
  agentContext("claude", [user("fix the flaky inbox test", 1), user(line, 2)]).said

describe("the doorbell lines core leaves out of the person's words", () => {
  it("are the lines harness-core types: the plain doorbell", () => {
    expect(said(doorbellLine("k3f9Xz"))).toEqual({ text: "fix the flaky inbox test", at: 1 })
  })

  it("and a task's start prompt, and the senders it names", () => {
    expect(said(startLine("k3f9Xz"))).toEqual({ text: "fix the flaky inbox test", at: 1 })
    expect(said(doorbellLine("k3f9Xz", ["newtz", "novadeck"]))).toEqual({
      text: "fix the flaky inbox test",
      at: 1,
    })
  })

  it("and the lines of sessions from before the tag", () => {
    const old = "[Novadeck: automatic notice, agent messages waiting, k3f9Xz]"
    const reply = '[Novadeck Inbox reply, k3f9Xz] Re "Merge #461?": I picked "Merge it". [k3f9Xz]'
    expect(said(old)).toEqual({ text: "fix the flaky inbox test", at: 1 })
    expect(said(reply)).toEqual({ text: "fix the flaky inbox test", at: 1 })
  })

  it("and the one that says the person's Inbox replies", () => {
    const line = replyLine([
      { subject: "Merge #461?", option: "Merge it", text: "" },
      { subject: "Which port?", text: "Use 5174" },
    ])
    expect(line).toBeDefined()
    expect(said(line!("k3f9Xz"))).toEqual({ text: "fix the flaky inbox test", at: 1 })
  })
})
