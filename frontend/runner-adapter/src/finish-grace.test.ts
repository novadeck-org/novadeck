import { finishGraceMs } from "@novadeck/core/agent-finish"

import { describe, expect, it } from "./test"

describe("the finish grace", () => {
  it("is the runner's: core mirrors it, as it may not import the runner's", async () => {
    const runner = await import("../../../backend/runner/src/terminals/turn-ends")
    expect(finishGraceMs).toBe(runner.finishGraceMs)
  })
})
