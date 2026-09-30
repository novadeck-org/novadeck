import { EditorState, Text } from "@codemirror/state"

import { context, describe, expect, it } from "../../../test"
import planV1 from "./fixtures/plan-v1.md?raw"
import planV2 from "./fixtures/plan-v2.md?raw"
import { lineChanges, merge, resolveNotes } from "./sync"

const v1 = planV1
const v2 = planV2
const text = (value: string): Text => Text.of(value.split("\n"))
const withNote = v1.replace(
  "warm ivory background.\n",
  "warm ivory background.\n<!-- novadeck: Use a grotesk. -->\n",
)

describe("plan editor sync", () => {
  context("when the file loads", () => {
    it("keeps the agent's text byte for byte", () => {
      expect(EditorState.create({ doc: withNote }).doc.toString()).toBe(withNote)
    })
  })

  context("when the agent rewrites the file", () => {
    it("turns one revision into the next", () => {
      expect(lineChanges(v1, v2).apply(text(v1)).toString()).toBe(v2)
    })

    it("changes only the lines it rewrote", () => {
      const untouched = v1.indexOf("## Scope")
      expect(lineChanges(v1, v2).touchesRange(untouched, untouched + 8)).toBe(false)
    })
  })

  context("when the user edited the file before the agent rewrote it", () => {
    const ours = withNote.replace("and deployment.", "and deployment. Also no blog.")
    const merged = merge(v1, ours, v2)

    it("keeps the user's edits and notes", () => {
      expect(merged.text).toContain("Also no blog.")
      expect(merged.text).toContain("<!-- novadeck: Use a grotesk. -->")
    })

    it("applies the agent's rewrite", () => {
      expect(merged.text).toContain("a confident grotesk for headlines")
      expect(merged.text).toContain("Add a Journal page")
    })

    it("marks what the agent wrote", () => {
      const written = merged.marks.map((mark) => merged.text.slice(mark.from, mark.to)).join("")
      expect(written).toContain("confident grotesk")
      expect(written).not.toContain("Also no blog.")
    })
  })

  context("when the agent resolves the notes", () => {
    const merged = merge(v1, withNote, v2)
    const resolved = resolveNotes(merged.text, merged.marks)

    it("removes each note with its line", () => {
      expect(resolved.resolved).toBe(1)
      expect(resolved.text).not.toContain("novadeck:")
      expect(resolved.text).not.toContain("\n\n\n")
    })

    it("leaves a table row as it was before its note", () => {
      const row = "| About | Contact |\n"
      const noted = row.replace("Contact |", "Contact <!-- novadeck: Email only --> |")
      expect(resolveNotes(noted, []).text).toBe(row)
    })

    it("keeps its marks on what it wrote", () => {
      const written = resolved.marks.map((mark) => resolved.text.slice(mark.from, mark.to)).join("")
      expect(written).toContain("confident grotesk")
    })
  })

  context("when the file doesn't end with a line break", () => {
    it("keeps a line added after the last one on its own line", () => {
      expect(merge("a\nb", "a\nb user", "a\nb\nc").text).toBe("a\nb user\nc")
      expect(merge("a\nb", "a\nb\nuser", "a\nb\nagent").text).toBe("a\nb\nuser\nagent")
    })

    it("ends as the agent left it when it changed that, else as the user did", () => {
      expect(merge("a\nb", "a\nb", "a\nb\n").text).toBe("a\nb\n")
      expect(merge("a\nb\n", "a\nb", "a\nc\n").text).toBe("a\nc")
    })
  })
})
