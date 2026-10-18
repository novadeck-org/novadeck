import { describe, expect, it } from "vitest"

import { visitorDemo } from "./index"

describe("the visitor demo", () => {
  it("offers exactly the fields the visitor page needs", () => {
    expect(Object.keys(visitorDemo()).toSorted()).toEqual([
      "commit",
      "companions",
      "mountTerminal",
      "newTerminal",
      "seed",
      "setFont",
      "start",
      "telemetry",
      "visitor",
    ])
  })
})
