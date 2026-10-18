import type { ScreenText } from "@novadeck/emulator/headless"
import { describe, expect, it } from "vitest"

import {
  agreeing,
  endsText,
  footerRows,
  isEmpty,
  markedBox,
  ruledBox,
  sameText,
  wrappedRows,
  type Markers,
} from "./box.js"

const markers: Markers = { prompt: "❯", shell: "!" }
const line = "─".repeat(20)

/** A screen of `rows`, the cursor at `row` and `column`, with nothing dim unless `bright` says. */
const screen = (
  rows: readonly string[],
  row: number,
  column: number,
  bright: readonly string[] = rows,
): ScreenText => ({
  rows,
  bright,
  bracketedPaste: true,
  alternate: false,
  columns: 40,
  cursor: { row, column },
})

describe("sameText and endsText", () => {
  it("ignore whitespace the program wrapped or indented anywhere", () => {
    expect(sameText("one two\n  three", "one two three")).toBe(true)
    expect(sameText("one two", "one two three")).toBe(false)
    expect(endsText("two three", "one two three")).toBe(true)
    expect(endsText("one", "one two three")).toBe(false)
  })

  it("ignore emoji a screen drew differently, but not a text of nothing else", () => {
    const family = "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}"
    expect(sameText("hi ", `hi ${family}`)).toBe(true)
    expect(sameText("", family)).toBe(false)
    expect(sameText(family, family)).toBe(true)
  })

  it("ends a text with nothing, or with emoji alone, only as drawn", () => {
    expect(endsText("", "abc")).toBe(false)
    expect(endsText("\u{1f600}", "abc")).toBe(false)
    expect(endsText("\u{1f600}", "hi \u{1f600}")).toBe(true)
    expect(endsText("hi", "hi \u{1f600}")).toBe(true)
  })
})

describe("wrappedRows", () => {
  it("wraps at word boundaries, a marker and indent aside", () => {
    expect(wrappedRows("aaaa bbbb", 8)).toBe(2)
    expect(wrappedRows("aaaa\nbbbb", 40)).toBe(2)
    expect(wrappedRows("a".repeat(13), 8)).toBe(3)
  })
})

describe("ruledBox", () => {
  const rows = ["history", line, "❯ hello", "  world", line, "footer"]

  it("reads the text between the lowest pair of rules, the cursor inside", () => {
    const box = ruledBox(screen(rows, 3, 7), markers)
    expect(box).toEqual({ text: "hello\nworld", mode: "prompt", first: 2, last: 3 })
    expect(box && isEmpty(box)).toBe(false)
  })

  it("reads no box with the cursor outside the rules", () => {
    expect(ruledBox(screen(rows, 5, 0), markers)).toBeUndefined()
  })

  it("reads a faint suggestion as an empty box", () => {
    const faint = { ...screen([line, "❯ try this", line], 1, 2), bright: [line, "❯", line] }
    const box = ruledBox(faint, markers)
    expect(box?.text).toBe("")
  })

  it("takes a faint suggestion for text only where the cursor is not at home", () => {
    const suggested = [line, "❯ try this", line]
    const faint = [line, "❯", line]
    expect(ruledBox(screen(suggested, 1, 2, faint), markers)?.text).toBe("")
    expect(ruledBox(screen(suggested, 1, 3, faint), markers)?.text).toBe("try this")
    const two = [line, "❯ try", "  this", line]
    const dim = [line, "❯", "", line]
    expect(ruledBox(screen(two, 1, 2, dim), markers)?.text).toBe("")
    expect(ruledBox(screen(two, 2, 2, dim), markers)?.text).toBe("try\nthis")
  })

  it("reads a placeholder's one lit letter under the cursor as no draft, a draft's not", () => {
    const hint = [line, "❯ Press up", line]
    const lit = [line, "❯ P", line]
    expect(ruledBox(screen(hint, 1, 2, lit), markers)?.text).toBe("")
    // The cursor away from home, or the rest not faint: a draft of one letter.
    expect(ruledBox(screen(hint, 1, 5, lit), markers)?.text).toBe("P")
    expect(ruledBox(screen([line, "❯ x", line], 1, 2), markers)?.text).toBe("x")
    // A draft longer than a letter, with the cursor sent home: still the person's draft.
    expect(ruledBox(screen([line, "❯ hello", line], 1, 2), markers)?.text).toBe("hello")
  })

  it("reads its mode off the marker leading the first row", () => {
    const shell = ruledBox(screen([line, "! ls -l", line], 1, 7), markers)
    expect(shell).toEqual({ text: "ls -l", mode: "shell", first: 1, last: 1 })
    const prompt = ruledBox(screen([line, "❯ ! not", line], 1, 7), markers)
    expect(prompt).toEqual({ text: "! not", mode: "prompt", first: 1, last: 1 })
  })

  it("takes off the marker of the mode it read, whatever its width", () => {
    const wide: Markers = { prompt: ">", shell: "!!" }
    const box = ruledBox(screen([line, "!! ls", line], 1, 5), wide)
    expect(box).toEqual({ text: "ls", mode: "shell", first: 1, last: 1 })
  })

  it("spans down to the closing rule, the cursor on any of its rows", () => {
    const framed = [line, "❯ a", "  b", line]
    expect(ruledBox(screen(framed, 1, 3), markers)).toEqual({
      text: "a\nb",
      mode: "prompt",
      first: 1,
      last: 2,
    })
  })

  it("starts at the nearest marked row above the cursor, stale rows aside", () => {
    const stale = [line, "❯ stale", "junk", "❯ real", "  more", line]
    expect(ruledBox(screen(stale, 4, 6), markers)).toEqual({
      text: "real\nmore",
      mode: "prompt",
      first: 3,
      last: 4,
    })
    expect(ruledBox(screen([line, "plain", line], 1, 3), markers)).toBeUndefined()
    expect(ruledBox(screen([line, line], 0, 0), markers)).toBeUndefined()
  })
})

describe("markedBox", () => {
  it("reads rows indented under the marker, up from the cursor", () => {
    const box = markedBox(screen(["old", "› hi", "  there"], 2, 7), { prompt: "›", shell: "!" })
    expect(box).toEqual({ text: "hi\nthere", mode: "prompt", first: 1, last: 2 })
  })

  it("reads no box where history sits between the cursor and a marker", () => {
    const rows = ["› hi", "output", "  more"]
    expect(markedBox(screen(rows, 2, 6), { prompt: "›", shell: "!" })).toBeUndefined()
  })

  it("takes a blank line for part of the body, but not on the cursor's own row", () => {
    const marked: Markers = { prompt: "›", shell: "!" }
    const body = markedBox(screen(["› a", "", "  b"], 2, 3), marked)
    expect(body).toEqual({ text: "a\n\nb", mode: "prompt", first: 0, last: 2 })
    expect(markedBox(screen(["› a", ""], 1, 0), marked)).toBeUndefined()
    expect(markedBox(screen(["› a", " b"], 1, 2), marked)).toBeUndefined()
    expect(markedBox(screen(["  x"], 0, 3), marked)).toBeUndefined()
  })
})

describe("agreeing", () => {
  it("refuses a prompt-marked box under a footer that says shell mode", () => {
    const box = { text: "", mode: "prompt", first: 0, last: 0 } as const
    expect(agreeing(box, true)).toBeUndefined()
    expect(agreeing(box, false)).toBe(box)
  })
})

describe("footerRows", () => {
  it("gives the rows from the cursor down, at least the last few", () => {
    const rows = ["a", "b", "c", "", "d", "e", "f"]
    expect(footerRows(screen(rows, 1, 0), 2)).toEqual(["b", "c", "d", "e", "f"])
    expect(footerRows(screen(rows, 6, 0), 2)).toEqual(["e", "f"])
  })

  it("takes a cursor within reach of the foot for an anchor, and a far one for none", () => {
    const rows = Array.from({ length: 15 }, (_, at) => `r${at}`)
    expect(footerRows(screen(rows.slice(0, 14), 2, 0))).toHaveLength(12)
    expect(footerRows(screen(rows, 2, 0))).toEqual(["r11", "r12", "r13", "r14"])
  })
})
