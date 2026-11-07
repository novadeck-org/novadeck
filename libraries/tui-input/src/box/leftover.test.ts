import { describe, expect, it } from "vitest"

import { screen } from "../testing/screens.js"
import type { BoxProfile, InputBox } from "./box.js"
import { eraseRows, fillsViewport, leaveShell, showsTail } from "./box.js"
import { cursorAtEnd, leftoverOf, menuRow, toEnd } from "./leftover.js"

const profile = (read: InputBox | undefined, over: Partial<BoxProfile> = {}): BoxProfile => ({
  read: () => read,
  stands: () => false,
  textWidth: (columns) => columns - 3,
  collapsed: () => false,
  shell: { expands: true, starts: false, footer: () => false },
  overlay: () => false,
  queued: () => false,
  collapses: () => false,
  room: (rows) => rows - 3,
  ...over,
})

const box = (text: string, first = 1, last = 1, mode: InputBox["mode"] = "prompt"): InputBox => ({
  text,
  mode,
  first,
  last,
})

const shown = screen({ rows: ["", "> words", "", "", "", "", "", "", "", ""] })

describe("leftoverOf", () => {
  it("says none where no box reads, or a view covers one", () => {
    expect(leftoverOf(profile(undefined), shown).kind).toBe("none")
    expect(leftoverOf(profile(box("words"), { overlay: () => true }), shown).kind).toBe("none")
    expect(leftoverOf(profile(box(""), { overlay: () => true }), shown).kind).toBe("none")
  })

  it("takes a numbered first row for a menu, never for text to go along with", () => {
    expect(leftoverOf(profile(box("1. Yes\n2. No")), shown).kind).toBe("none")
    expect(leftoverOf(profile(box("2) Pick this")), shown).kind).toBe("none")
    expect(menuRow("  1. Yes")).toBe(true)
    expect(menuRow("1.5 is the version")).toBe(false)
    expect(menuRow("1 thing")).toBe(false)
  })

  it("calls a box that says it is cut a tail, as one as tall as its viewport", () => {
    const cut = { cut: ({ text }: InputBox) => text.startsWith("↑") }
    expect(leftoverOf(profile(box("↑ 10 more lines\nwords"), cut), shown)).toMatchObject({
      kind: "text",
      tail: true,
    })
    expect(leftoverOf(profile(box("words"), cut), shown)).toMatchObject({ tail: false })
  })

  it("tells text from what its program runs as a command", () => {
    expect(leftoverOf(profile(box("words")), shown).kind).toBe("text")
    expect(leftoverOf(profile(box("see /tmp")), shown).kind).toBe("text")
    expect(leftoverOf(profile(box("/help")), shown).kind).toBe("command")
    expect(leftoverOf(profile(box("!ls")), shown).kind).toBe("command")
  })

  it("says a shell mode whatever it holds, and an empty box", () => {
    expect(leftoverOf(profile(box("", 1, 1, "shell")), shown).kind).toBe("shell")
    expect(leftoverOf(profile(box("ls", 1, 1, "shell")), shown).kind).toBe("shell")
    expect(leftoverOf(profile(box("  ")), shown).kind).toBe("empty")
  })

  it("flags a box as tall as its viewport, which may show only a tail", () => {
    const viewport = () => 3
    expect(leftoverOf(profile(box("a\nb\nc", 1, 3), { viewport }), shown)).toMatchObject({
      kind: "text",
      tail: true,
    })
    expect(leftoverOf(profile(box("a\nb", 1, 2), { viewport }), shown)).toMatchObject({
      kind: "text",
      tail: false,
    })
  })
})

describe("fillsViewport and showsTail", () => {
  it("take a one-row viewport, which every box has, for no viewport", () => {
    const one = profile(box("a"), { viewport: () => 1 })
    expect(fillsViewport(one, box("a"), 10)).toBe(false)
    expect(showsTail(one, box("a"), 10, "the words a")).toBe(false)
  })

  it("find a text's tail in a full box", () => {
    const two = profile(box("a"), { viewport: () => 2 })
    expect(showsTail(two, box("c\nd", 1, 2), 10, "a b c d")).toBe(true)
    expect(showsTail(two, box("c\nx", 1, 2), 10, "a b c d")).toBe(false)
  })
})

describe("cursorAtEnd", () => {
  const at = (row: number, column: number) =>
    screen({ rows: ["", "> words", ""], cursor: { row, column } })

  it("is true past the last row's text, and false anywhere before it", () => {
    expect(cursorAtEnd(profile(box("words")), box("words"), at(1, 7))).toBe(true)
    expect(cursorAtEnd(profile(box("words")), box("words"), at(1, 6))).toBe(false)
    expect(cursorAtEnd(profile(box("words")), box("words"), at(2, 7))).toBe(false)
  })

  it("takes a cursor far past the text for none in the box, as a menu parks it", () => {
    expect(cursorAtEnd(profile(box("words")), box("words"), at(1, 12))).toBe(true)
    expect(cursorAtEnd(profile(box("words")), box("words"), at(1, 40))).toBe(false)
    expect(toEnd(box("words"), at(1, 40))).toBeUndefined()
  })

  it("takes the harness's caret off the column", () => {
    const caret = profile(box("words"), { caret: 1 })
    expect(cursorAtEnd(caret, box("words"), at(1, 6))).toBe(true)
    expect(cursorAtEnd(caret, box("words"), at(1, 5))).toBe(false)
  })

  it("goes by the text as drawn undimmed, as a faint suggestion after it is none of it", () => {
    const faint = screen({
      rows: ["> words and more"],
      bright: ["> words"],
      cursor: { row: 0, column: 7 },
    })
    expect(cursorAtEnd(profile(box("words", 0, 0)), box("words", 0, 0), faint)).toBe(true)
  })
})

describe("toEnd", () => {
  it("goes down exactly to the last row, then End, and nowhere from outside the box", () => {
    const threeRows = box("a\nb\nc", 1, 3)
    const cursor = (row: number) => screen({ rows: ["", "", "", ""], cursor: { row, column: 0 } })
    expect(toEnd(threeRows, cursor(1))).toBe("\x1b[B\x1b[B\x1b[F")
    expect(toEnd(threeRows, cursor(3))).toBe("\x1b[F")
    expect(toEnd(threeRows, cursor(0))).toBeUndefined()
  })
})

describe("the keys that empty a box", () => {
  it("kill each row and join it to the one above", () => {
    expect(eraseRows(box("a", 4, 4))).toBe("\x15")
    expect(eraseRows(box("a\nb\nc", 4, 6))).toBe("\x15\x7f\x15\x7f\x15")
  })

  it("leave a shell mode with a Backspace, once any command is gone", () => {
    expect(leaveShell(box("", 4, 4, "shell"))).toBe("\x7f")
    expect(leaveShell(box("ls", 4, 4, "shell"))).toBe("\x15\x7f")
    expect(leaveShell(box("a\nb", 4, 5, "shell"))).toBe("\x15\x7f\x15\x7f")
  })
})
