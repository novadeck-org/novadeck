import { describe, expect, it } from "vitest"

import { deliveredKeys } from "./registry.js"

const keys = [{ kind: "neutral" as const }, { kind: "escape" as const }]
const question = { kind: "question" }
const permission = { kind: "permission" }

describe("deliveredKeys", () => {
  it("drops an Escape that only skips the question waiting, as Antigravity's does", () => {
    expect(deliveredKeys("agy", [question], keys)).toEqual(["neutral"])
    expect(deliveredKeys("agy", [question, question], keys)).toEqual(["neutral"])
  })

  it("keeps an Escape that may stop the turn", () => {
    // Antigravity's in a confirmation interrupts the turn.
    expect(deliveredKeys("agy", [permission], keys)).toEqual(["neutral", "escape"])
    expect(deliveredKeys("agy", [question, permission], keys)).toEqual(["neutral", "escape"])
    // Claude Code's and Codex's in a question end the turn.
    expect(deliveredKeys("claude", [question], keys)).toEqual(["neutral", "escape"])
    expect(deliveredKeys("codex", [question], keys)).toEqual(["neutral", "escape"])
    // With nothing waiting, or no agent bound, it is the person's Stop.
    expect(deliveredKeys("agy", [], keys)).toEqual(["neutral", "escape"])
    expect(deliveredKeys(undefined, [question], keys)).toEqual(["neutral", "escape"])
  })
})
