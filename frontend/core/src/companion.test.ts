import { ownItemWith, pathOf, samePointer, shownItemWith, type CompanionItem } from "./companion"
import { context, describe, expect, it } from "./test"
import { itemFixture } from "./testing"

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

describe("what an agent showed of a file or page", () => {
  const page = (id: string, url: string, holder: CompanionItem["holder"] = { terminalId: "01" }) =>
    itemFixture(id, "01", { kind: "page", path: null, url, holder })

  it("is on its own bar first, else where the person moved it", () => {
    const moved = page("moved", "http://localhost:4323/", { windowId: "w1" })
    expect(shownItemWith([moved], "01", moved)).toBe(moved)
    const own = page("own", "http://localhost:4323/")
    expect(shownItemWith([moved, own], "01", moved)).toBe(own)
    expect(ownItemWith([moved], "01", moved)).toBeUndefined()
    expect(shownItemWith([{ ...moved, by: "person" }], "01", moved)).toBeUndefined()
  })

  it("is one page for a server on this machine at any route, and any page at any anchor", () => {
    const site = page("site", "http://localhost:4323/download#linux")
    expect(samePointer(site, page("faq", "http://127.0.0.1:4323/#faq"))).toBe(true)
    expect(samePointer(site, page("other", "http://localhost:4330/"))).toBe(false)
    const artifact = page("a", "https://claude.ai/artifact/A")
    expect(samePointer(artifact, page("e", "https://claude.ai/artifact/A#opt-e"))).toBe(true)
    expect(samePointer(artifact, page("b", "https://claude.ai/artifact/B"))).toBe(false)
  })
})
