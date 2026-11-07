import { agentContext } from "@novadeck/core/agents/steps"
import type { ChatItem } from "@novadeck/core/conversation"
import { doorbellLine, replyLine } from "@novadeck/harness-core/prompts"

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

  it("and the one that says the person's Inbox replies", () => {
    const line = replyLine([
      { subject: "Merge #461?", option: "Merge it", text: "" },
      { subject: "Which port?", text: "Use 5174" },
    ])
    expect(line).toBeDefined()
    expect(said(line!("k3f9Xz"))).toEqual({ text: "fix the flaky inbox test", at: 1 })
  })
})
