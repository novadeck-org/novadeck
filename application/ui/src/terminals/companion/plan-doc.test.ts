import type { ItemContent } from "#core/companion"

import { describe, expect, it } from "../../test"
import { docOf, stuckEdits } from "./plan-doc"

const doc = docOf({
  stamp: "1",
  plan: { kind: "plan", text: "a\n", truncated: false, writable: true, skill: true },
})
const edited = { ...doc, text: "a\nb\n" }
const gone: ItemContent = { state: "unavailable", reason: "gone", size: null }
const unreadable: ItemContent = { state: "unavailable", reason: "unreadable", size: null }

describe("edits that can't reach the file", () => {
  it("are those left over when saves are blocked, stalled, or the file is gone or unreadable", () => {
    expect(stuckEdits({ ...edited, blocked: "folder" }, undefined)).toBe(true)
    expect(stuckEdits({ ...edited, stalled: true }, undefined)).toBe(true)
    expect(stuckEdits(edited, gone)).toBe(true)
    expect(stuckEdits(edited, unreadable)).toBe(true)
  })

  it("are none while saving still works, or when nothing was edited", () => {
    expect(stuckEdits(edited, undefined)).toBe(false)
    expect(stuckEdits({ ...doc, blocked: "folder" }, gone)).toBe(false)
  })
})
