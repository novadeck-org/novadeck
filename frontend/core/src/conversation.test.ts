import type {
  ToolOutcome as ProtocolToolOutcome,
  ToolRun as ProtocolToolRun,
} from "@novadeck/protocol"

import type { ToolOutcome, ToolRun } from "./conversation"
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
