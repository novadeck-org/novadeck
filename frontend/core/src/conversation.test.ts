import type { ToolRun as ProtocolToolRun } from "@novadeck/protocol"

import type { ToolRun } from "./conversation"
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
