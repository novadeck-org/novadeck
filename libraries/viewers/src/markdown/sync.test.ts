import { EditorState, Text } from "@codemirror/state"
import { describe as context, describe, expect, it } from "vitest"

import v1 from "./fixtures/plan-v1.md?raw"
import v2 from "./fixtures/plan-v2.md?raw"
import { distance, lineChanges, merge } from "./sync.js"

const text = (value: string): Text => Text.of(value.split("\n"))
const withNote = v1.replace(
  "warm ivory background.\n",
  "warm ivory background.\n<!-- Use a grotesk. -->\n",
)

describe("markdown sync", () => {
  context("when the file loads", () => {
    it("keeps the text byte for byte", () => {
      expect(EditorState.create({ doc: withNote }).doc.toString()).toBe(withNote)
    })
  })

  context("when the text is rewritten", () => {
    it("turns one revision into the next", () => {
      expect(lineChanges(v1, v2).apply(text(v1)).toString()).toBe(v2)
    })

    it("changes only the lines it rewrote", () => {
      const untouched = v1.indexOf("## Scope")
      expect(lineChanges(v1, v2).touchesRange(untouched, untouched + 8)).toBe(false)
    })
  })

  context("when the text was edited before it was rewritten", () => {
    const ours = withNote.replace("and deployment.", "and deployment. Also no blog.")
    const merged = merge(v1, ours, v2)

    it("keeps the edits made meanwhile", () => {
      expect(merged.text).toContain("Also no blog.")
      expect(merged.text).toContain("<!-- Use a grotesk. -->")
    })

    it("applies the rewrite", () => {
      expect(merged.text).toContain("a confident grotesk for headlines")
      expect(merged.text).toContain("Add a Journal page")
    })

    it("reports what the rewrite wrote", () => {
      const written = merged.changed
        .map((range) => merged.text.slice(range.from, range.to))
        .join("")
      expect(written).toContain("confident grotesk")
      expect(written).not.toContain("Also no blog.")
    })
  })

  context("when the file doesn't end with a line break", () => {
    it("keeps a line added after the last one on its own line", () => {
      expect(merge("a\nb", "a\nb user", "a\nb\nc").text).toBe("a\nb user\nc")
      expect(merge("a\nb", "a\nb\nuser", "a\nb\nagent").text).toBe("a\nb\nuser\nagent")
    })

    it("ends as the agent left it when it changed that, else as the person did", () => {
      expect(merge("a\nb", "a\nb", "a\nb\n").text).toBe("a\nb\n")
      expect(merge("a\nb\n", "a\nb", "a\nc\n").text).toBe("a\nc")
    })
  })

  it("measures how far apart two texts are by the lines that differ", () => {
    expect(distance("a\nb\n", "a\nb\n")).toBe(0)
    expect(distance("a\nb\n", "a\nB\n")).toBeLessThan(distance("a\nb\n", "A\nB\n"))
  })
})
