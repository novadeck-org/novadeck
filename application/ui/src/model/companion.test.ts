import { context, describe, expect, it } from "../test"
import { itemFixture } from "../test/fixtures"
import { pathOf } from "./companion"

describe("an item's file", () => {
  it("is the file it points at", () => {
    expect(pathOf(itemFixture("notes", "01"))).toBe("/project/src/notes.ts")
  })

  context("for a plan in its agent's conversation", () => {
    it("is none, as the conversation record isn't the plan", () => {
      const plan = itemFixture("plan", "01", {
        kind: "plan",
        path: "~/.codex/sessions/rollout.jsonl",
        plan: { agent: "Codex", role: "root", source: "text" },
      })
      expect(pathOf(plan)).toBeNull()
      expect(pathOf({ ...plan, plan: { ...plan.plan!, source: "file" } })).toBe(plan.path)
    })
  })
})
