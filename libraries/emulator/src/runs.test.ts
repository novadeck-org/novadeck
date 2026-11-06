import { describe, expect, it } from "vitest"

import { styledRows } from "./runs.js"
import { createScreen, written } from "./screen.js"

const screenWith = async (text: string, cols = 20) => {
  const screen = createScreen({ cols, rows: 4, scrollback: 0 })
  await written(screen, text)
  return screen
}

const plain = {
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
}

describe("styledRows", () => {
  it("joins cells of one style and keeps none of the blanks that end a row", async () => {
    const screen = await screenWith("plain\r\n\r\n")
    expect(styledRows(screen, 0, 1)).toEqual([[{ ...plain, text: "plain", width: 5 }], []])
  })

  it("reads each style: attributes, palette and RGB colours", async () => {
    const screen = await screenWith(
      "\x1b[1;2;3;4mA\x1b[0m\x1b[31mB\x1b[0m\x1b[38;2;1;2;255mC\x1b[0m",
    )
    expect(styledRows(screen, 0, 0)[0]).toEqual([
      { ...plain, text: "A", width: 1, bold: true, dim: true, italic: true, underline: true },
      { ...plain, text: "B", width: 1, fg: 1 },
      { ...plain, text: "C", width: 1, fg: "#0102ff" },
    ])
  })

  it("keeps blanks that draw: a bar's ground and an inverse cursor", async () => {
    const screen = await screenWith("\x1b[44mbar  \x1b[0m  \x1b[7m \x1b[0m")
    const [row] = styledRows(screen, 0, 0)
    expect(row!.map(({ text, width }) => [text, width])).toEqual([
      ["bar  ", 5],
      ["  ", 2],
      [" ", 1],
    ])
  })

  it("counts a double-width character as two columns", async () => {
    const screen = await screenWith("a界b")
    expect(styledRows(screen, 0, 0)[0]).toEqual([{ ...plain, text: "a界b", width: 4 }])
  })

  it("draws an invisible cell as a space", async () => {
    const screen = await screenWith("a\x1b[8mhidden\x1b[0mb")
    expect(
      styledRows(screen, 0, 0)[0]!
        .map(({ text }) => text)
        .join(""),
    ).toBe("a      b")
  })
})
