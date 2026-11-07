import { describe, expect, it } from "vitest"

import { agentProcess } from "./ending.js"

const bound = (instance: string | null) =>
  ({ bound: { binding: { instance } } }) as Parameters<typeof agentProcess>[0]

describe("the agent a terminal's end follows", () => {
  it("is the bound agent's process, as its hooks told it", () => {
    expect(agentProcess(bound("4242"))).toBe(4242)
  })

  it("is none with no agent bound, no record, or no pid told", () => {
    expect(agentProcess({ bound: null })).toBeUndefined()
    expect(agentProcess(undefined)).toBeUndefined()
    expect(agentProcess(bound(null))).toBeUndefined()
  })

  it("is none for what can't be a process of its own", () => {
    for (const instance of ["", "abc", "1", "0", "-5", "1.5"])
      expect(agentProcess(bound(instance))).toBeUndefined()
  })
})
