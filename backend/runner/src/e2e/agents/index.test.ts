import { agentNames } from "@novadeck/protocol"

import { describe, expect, it } from "../../test.js"
import { setups } from "./index.js"

describe("the end-to-end setups", () => {
  it("has one per harness, filed under its own agent, in the protocol's order", () => {
    expect(setups.map(({ agent }) => agent)).toEqual(agentNames)
  })
})
