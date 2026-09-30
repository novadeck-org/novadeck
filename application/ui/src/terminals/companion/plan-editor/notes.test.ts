import { EditorState, Text } from "@codemirror/state"

import { context, describe, expect, it } from "../../../test"
import {
  caretInNote,
  emptyNoteRemovals,
  leaveNote,
  noteInput,
  noteSafe,
  notesReopened,
  withoutEmptyNotes,
} from "./notes"

const doc = (value: string): Text => Text.of(value.split("\n"))
const apply = (value: string, removals: { from: number; to: number }[]): string =>
  removals
    .toSorted((a, b) => b.from - a.from)
    .reduce((text, { from, to }) => text.slice(0, from) + text.slice(to), value)

describe("plan notes", () => {
  context("when a note's line is clicked", () => {
    const text = "Intro\n   <!-- novadeck: Hello -->\nNext"
    const body = text.indexOf("Hello")
    const close = body + "Hello".length

    it("puts the caret in the note's text past its end", () => {
      expect(caretInNote(doc(text), text.indexOf("\nNext"))).toBe(close)
    })

    it("puts the caret in the note's text before its start", () => {
      expect(caretInNote(doc(text), text.indexOf("   <!--"))).toBe(body)
    })

    it("leaves a caret already in the text", () => {
      expect(caretInNote(doc(text), body + 2)).toBe(body + 2)
    })

    it("leaves other lines alone", () => {
      expect(caretInNote(doc(text), 2)).toBe(2)
    })
  })

  context("when a note is left empty", () => {
    const text = "Intro\n<!-- novadeck:  -->\n| a | b <!-- novadeck:  --> |\nEnd"

    it("drops it with its line, and one inside a line with its space", () => {
      expect(apply(text, emptyNoteRemovals(doc(text), null))).toBe("Intro\n| a | b |\nEnd")
    })

    it("keeps the one the caret is in", () => {
      const caret = text.indexOf("<!--") + 5
      expect(apply(text, emptyNoteRemovals(doc(text), caret))).toBe(
        "Intro\n<!-- novadeck:  -->\n| a | b |\nEnd",
      )
    })

    it("leaves a table's row notes to the table", () => {
      const table = "| a | b |\n| --- | --- |\n| c | d <!-- novadeck:  --> |\n"
      expect(emptyNoteRemovals(doc(table), null)).toEqual([])
    })

    it("keeps notes with text", () => {
      expect(emptyNoteRemovals(doc("<!-- novadeck: Hi -->"), null)).toEqual([])
    })
  })
})

describe("plan notes and Enter", () => {
  const text = "<!-- novadeck: Hello -->\nNext"

  it("finishes a note, going to the end of its line", () => {
    expect(leaveNote(doc(text), 17)).toEqual({ at: text.indexOf("\nNext") })
  })

  it("leaves other lines to the editor", () => {
    expect(leaveNote(doc(text), text.length)).toBeNull()
  })
})

describe("plan notes and what's typed in them", () => {
  const text = "<!-- novadeck: use a -->\nNext"
  const end = text.indexOf(" -->")

  it("keeps a note's comment closed when `-->` is typed in it", () => {
    const change = noteInput(doc("<!-- novadeck: use a -- -->"), 23, 23, ">")!
    expect(change.insert).toBe("use a ->")
    expect(noteSafe("a --> b\nc")).toBe("a -> b c")
    expect(noteSafe("--->")).toBe("->")
  })

  it("leaves ordinary typing, and text outside notes, to the editor", () => {
    expect(noteInput(doc(text), end, end, " b")).toBeNull()
    expect(noteInput(doc(text), text.length, text.length, "-->")).toBeNull()
  })

  it("keeps it closed when a deletion joins `--` and `>`", () => {
    const note = "<!-- novadeck: p --x> q -->"
    const x = note.indexOf("x")
    const deleted = EditorState.create({ doc: note }).update({
      changes: { from: x, to: x + 1 },
      userEvent: "delete.backward",
    })
    const [fix] = notesReopened(deleted)
    expect(fix && deleted.newDoc.replace(fix.from, fix.to, Text.of([fix.insert])).toString()).toBe(
      "<!-- novadeck: p -> q -->",
    )
  })
})

describe("plan notes left empty when the editor closes", () => {
  it("go, with the highlights after them moved to match", () => {
    const text = "A\n<!-- novadeck:  -->\nB"
    expect(withoutEmptyNotes(text, [{ from: text.indexOf("B"), to: text.length }])).toEqual({
      text: "A\nB",
      marks: [{ from: 2, to: 3 }],
    })
  })

  it("leave a plan without them alone", () => {
    expect(withoutEmptyNotes("A\n<!-- novadeck: Hi -->", [])).toBeNull()
  })
})
