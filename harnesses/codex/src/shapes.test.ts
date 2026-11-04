import { describe, expect, it } from "vitest"

import { conversational, shapes } from "./shapes.js"

const item = (type: string) =>
  shapes(JSON.stringify({ type: "response_item", payload: { type } })).map(
    ({ key, verdict }) => `${key} ${verdict}`,
  )

describe("Codex's shapes", () => {
  it("know every response item the 0.166.0 binary names but its catch-all, so none raises the notice", () => {
    // The Responses API's own tools, which the chat shows as tool rows.
    expect(item("local_shell_call")).toEqual(["item:local_shell_call read"])
    expect(item("web_search_call")).toEqual(["item:web_search_call read"])
    expect(item("image_generation_call")).toEqual(["item:image_generation_call read"])
    // Tool lookups and compaction's bookkeeping, which the chat leaves out.
    for (const type of [
      "tool_search_call",
      "tool_search_output",
      "compaction",
      "compaction_summary",
      "compaction_trigger",
      "context_compaction",
      "configuration_update",
      "additional_tools",
      "ghost_snapshot",
    ])
      expect(item(type)).toEqual([`item:${type} skipped`])
  })

  it("count an item no release named yet as the conversation's", () => {
    // Codex's own catch-all (`other`, an item it couldn't read) holds something it wrote.
    expect(item("other")).toEqual(["item:other unknown"])
    expect(item("hologram_call")).toEqual(["item:hologram_call unknown"])
    expect(conversational("item:hologram_call")).toBe(true)
    expect(conversational("record:brand_new_record")).toBe(false)
  })
})
