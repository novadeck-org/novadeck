import { describe, expect, it, vi } from "vitest"

import { fakeRunner } from "./runner.test-support.js"

// The contract has no marked input value yet, so this file has one of its own: the real
// contract with the settings' `agentMode` marked, as `inputEnum` writes it. `swarm` came one
// revision after the runner fakeRunner connects to; `solo`, in the runner's own.
vi.mock("@novadeck/protocol", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@novadeck/protocol")>()
  const set = actual.contract.settings.set["~orpc"]
  const input = set.inputSchema as unknown as {
    shape: { agentMode: { unwrap: () => { meta: (mark: object) => { optional: () => unknown } } } }
    extend: (shape: object) => unknown
  }
  const marked = input.shape.agentMode
    .unwrap()
    .meta({
      "x-since": { swarm: actual.compatibility.revision + 1, solo: actual.compatibility.revision },
    })
    .optional()
  return {
    ...actual,
    contract: {
      ...actual.contract,
      settings: {
        ...actual.contract.settings,
        set: {
          ...actual.contract.settings.set,
          "~orpc": { ...set, inputSchema: input.extend({ agentMode: marked }) },
        },
      },
    },
  }
})

describe("supports, with a value of an input marked since a revision", () => {
  it("says no for one past the runner's revision, and yes for the rest", async () => {
    const { runner } = await fakeRunner({})
    expect(runner.supports("settings.set", { at: "agentMode", value: "swarm" })).toBe(false)
    expect(runner.supports("settings.set", { at: "agentMode", value: "solo" })).toBe(true)
    expect(runner.supports("settings.set", { at: "agentMode", value: "herd" })).toBe(true)
    expect(runner.supports("settings.set")).toBe(true)
  })

  it("says no for a place the input doesn't have", async () => {
    const { runner } = await fakeRunner({})
    expect(runner.supports("settings.set", { at: "agentMods", value: "herd" })).toBe(false)
  })

  it("rejects a call holding such a value with UNSUPPORTED, without asking the runner", async () => {
    const { runner } = await fakeRunner({})
    await expect(runner.settings.set({ agentMode: "swarm" })).rejects.toMatchObject({
      code: "UNSUPPORTED",
    })
  })
})
