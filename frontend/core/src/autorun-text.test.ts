import { autoRunBody, outcomeText } from "./autorun-text"
import { describe, expect, it } from "./test"

describe("the fix's confirm", () => {
  it("says when Undo is held: a running terminal, a restart, or a plugin not yet replaced", () => {
    expect(autoRunBody).toContain("except while an Antigravity terminal is running")
    expect(autoRunBody).toContain("restart first")
    expect(autoRunBody).toContain("plugin is still to be replaced")
  })
})

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
