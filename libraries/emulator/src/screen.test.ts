import { describe, expect, it } from "vitest"

import { createScreen, readScreen, serializerOf, written } from "./screen.js"
import { snapshot } from "./snapshot.js"
import { cells } from "./width.js"

const draw = (row: number, text: string) => `\u001b[${row};1H${text}`

describe("a screen", () => {
  it("counts widths as every emulator here does", async () => {
    const screen = createScreen({ cols: 200, rows: 4, scrollback: 0 })
    const text = "\u{1f468}‍\u{1f469}‍\u{1f467}あ\u{1f1f5}\u{1f1f1}é"
    await written(screen, text)
    expect(screen.buffer.active.cursorX).toBe(cells(text))
    screen.dispose()
  })

  it("serializes through one serializer of its own", async () => {
    const screen = createScreen({ cols: 10, rows: 2, scrollback: 10 })
    expect(serializerOf(screen)).toBe(serializerOf(screen))
    await written(screen, "hello")
    expect(snapshot(screen, { fits: () => true, mouse: "default" })).toContain("hello")
    screen.dispose()
  })
})

describe("a screen read as text", () => {
  it("reads which rows are full from a real terminal's cells, never from string lengths", async () => {
    const screen = createScreen({ cols: 8, rows: 8, scrollback: 1000 })
    await written(
      screen,
      `\u001b[2J${draw(1, "abcdefgh")}${draw(2, "abc")}${draw(3, "abcdefg ")}${draw(4, "あいうえ")}${draw(5, "abcdefge\u0301")}${draw(6, "abcdefg")}`,
    )
    const text = readScreen(screen)
    expect(text.wrapped?.some(Boolean)).toBe(false)
    // Full: plain text to the last column, double-width characters to it, and a combining
    // mark in it. Not: short rows, a trailing blank, an empty row.
    expect(text.continues).toEqual([true, false, false, true, true, false, false, false])
    screen.dispose()
  })

  it("blanks the dim cells in the bright rows, and tells the cursor, the paste mode and the alternate screen", async () => {
    const screen = createScreen({ cols: 20, rows: 4, scrollback: 0 })
    await written(screen, "\u001b[?2004h> typed \u001b[2mhint\u001b[22m")
    const text = readScreen(screen)
    expect(text.rows[0]).toBe("> typed hint")
    expect(text.bright[0]).toBe("> typed")
    expect(text).toMatchObject({
      cursor: { row: 0, column: 12 },
      columns: 20,
      bracketedPaste: true,
      alternate: false,
    })
    await written(screen, "\u001b[?1049h")
    expect(readScreen(screen).alternate).toBe(true)
    screen.dispose()
  })

  it("marks a row the terminal wrapped as continuing the one before", async () => {
    const screen = createScreen({ cols: 5, rows: 3, scrollback: 0 })
    await written(screen, "abcdefg")
    expect(readScreen(screen).wrapped).toEqual([false, true, false])
    screen.dispose()
  })
})
