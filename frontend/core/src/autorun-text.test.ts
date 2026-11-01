import { outcomeText } from "./autorun-text"
import { describe, expect, it } from "./test"

describe("what the fix says a click came to", () => {
  it("names the terminals or the restart that an install waits for", () => {
    expect(outcomeText({ kind: "applied-clean", waiting: ["fox"], restart: false })).toContain(
      "once @fox closes",
    )
    expect(outcomeText({ kind: "applied-clean", waiting: [], restart: true })).toContain(
      "after Novadeck restarts",
    )
    expect(outcomeText({ kind: "applied-clean", waiting: [], restart: false })).toBe(
      "Command Prompt prints nothing at startup now.",
    )
    expect(outcomeText({ kind: "undo-refused", terminals: [], restart: true })).toContain(
      "Restart Novadeck",
    )
    expect(
      outcomeText({ kind: "undo-refused", terminals: ["fox", "owl"], restart: false }),
    ).toContain("@fox, @owl")
  })
})
