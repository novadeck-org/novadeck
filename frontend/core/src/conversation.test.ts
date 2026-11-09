import type {
  ToolOutcome as ProtocolToolOutcome,
  ToolRun as ProtocolToolRun,
} from "@novadeck/protocol"

import { type ChatRequest, questionWaits, type ToolOutcome, type ToolRun } from "./conversation"
import { describe, expect, it } from "./test"

// The core declares its own tool run, since it reads no more of the protocol than its data
// entries. The two must stay the same shape: each assignable to the other.
describe("the core's ToolRun", () => {
  it("is the protocol's, in both directions", () => {
    const fromProtocol = (run: ProtocolToolRun): ToolRun => run
    const toProtocol = (run: ToolRun): ProtocolToolRun => run
    const run = { kind: "run", title: "Ran", detail: "ls" } as const
    expect(fromProtocol(toProtocol(run))).toEqual(run)
  })
})

describe("the core's ToolOutcome", () => {
  it("is the protocol's, in both directions", () => {
    const fromProtocol = (outcome: ProtocolToolOutcome): ToolOutcome => outcome
    // The core's lists are readonly, which is all that sets the two apart.
    const toProtocol = (outcome: ToolOutcome): ProtocolToolOutcome => ({
      ...outcome,
      change: outcome.change && { ...outcome.change, lines: [...outcome.change.lines] },
    })
    const outcome = {
      failed: false,
      exit: 0,
      running: false,
      size: { count: 6, unit: "line" },
      change: { added: 1, removed: 0, lines: [{ sign: "+", text: "a", line: 1 }] },
      opening: true,
    } as const
    expect(fromProtocol(toProtocol(outcome))).toEqual(outcome)
  })
})

describe("questionWaits", () => {
  const request = (change: Partial<ChatRequest> = {}): ChatRequest => ({
    id: "r1",
    kind: "question",
    tool: "AskUserQuestion",
    subject: null,
    choices: [],
    subagent: false,
    dialog: { type: "questions", id: "d1", chat: "prompt", questions: [] },
    answered: false,
    ...change,
  })

  it("holds for a question the chat reads, not yet answered", () => {
    expect(questionWaits([request()])).toBe(true)
    expect(questionWaits([request({ kind: "permission" }), request({ id: "r2" })])).toBe(true)
  })

  it("never for a permission, a plan, one answered or one the chat can't read", () => {
    expect(questionWaits([])).toBe(false)
    expect(questionWaits([request({ kind: "permission" })])).toBe(false)
    expect(questionWaits([request({ kind: "plan" })])).toBe(false)
    expect(questionWaits([request({ answered: true })])).toBe(false)
    expect(
      questionWaits([request({ dialog: { type: "raw", text: "?", reason: "unrecognized" } })]),
    ).toBe(false)
    expect(questionWaits([request({ dialog: null })])).toBe(false)
  })
})
