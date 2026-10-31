import { finishGraceMs } from "@novadeck/core/agents/finish"
import { finishGraceMs as runnersGraceMs } from "@novadeck/runner"

import { describe, expect, it } from "../test"

describe("the finish grace", () => {
  it("is the runner's: core mirrors it, as it may not import the runner's", () => {
    expect(finishGraceMs).toBe(runnersGraceMs)
  })
})
