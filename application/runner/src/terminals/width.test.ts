import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import headless from "@xterm/headless"

import { describe, expect, it } from "../test.js"
import { cells } from "./width.js"

const family = "\u{1f468}‍\u{1f469}‍\u{1f467}"
const flag = "\u{1f1f5}\u{1f1f1}"
const thumb = "\u{1f44d}\u{1f3fd}"
const heart = "❤️"
const keycap = "1️⃣"
const acute = "é"

/** How far the emulator's cursor moves as it draws the text, on a screen too wide to wrap it. */
const drawn = async (text: string): Promise<number> => {
  const screen = new headless.Terminal({ cols: 200, rows: 4, allowProposedApi: true })
  screen.loadAddon(new UnicodeGraphemesAddon())
  screen.unicode.activeVersion = "15-graphemes"
  await new Promise<void>((done) => screen.write(text, done))
  const column = screen.buffer.active.cursorX
  screen.dispose()
  return column
}

describe("the width of text on the screen", () => {
  it.each([
    ["a curly quote", "“"],
    ["a right single quote", "’"],
    ["an en dash", "–"],
    ["an em dash", "—"],
    ["an ellipsis", "…"],
    ["a bullet", "•"],
    ["Latin letters with accents", "éñü"],
    ["a Cyrillic word", "привет"],
  ])("counts %s one column per character", (_name, text) => {
    expect(cells(text)).toBe([...text].length)
  })

  it("counts a sentence set in typographic punctuation as it reads", () => {
    expect(cells("“Wait” — she said… it’s fine")).toBe(28)
  })

  it.each([
    ["Chinese", "中文", 4],
    ["Japanese", "日本語", 6],
    ["Hangul", "한글", 4],
    ["a fullwidth letter", "Ａ", 2],
    ["an emoji", "\u{1f600}", 2],
  ])("counts %s two columns per character", (_name, text, width) => {
    expect(cells(text)).toBe(width)
  })

  it("counts a combining mark as nothing", () => {
    expect(cells(acute)).toBe(1)
    expect(cells("à́̂")).toBe(1)
  })

  it("counts a joined emoji sequence, a flag and a modified emoji as the one picture they make", () => {
    expect(cells(family)).toBe(2)
    expect(cells(flag)).toBe(2)
    expect(cells(thumb)).toBe(2)
    expect(cells(heart)).toBe(2)
  })

  it("counts nothing for nothing", () => {
    expect(cells("")).toBe(0)
  })

  it("agrees with the emulator on what it draws", async () => {
    const texts = [
      "plain ascii text",
      "“quoted” — and – and…",
      "日本語 mixed with ascii 中文",
      `Thanks ${heart} heart ${family} family`,
      `${flag}${flag} ${thumb}${thumb}`,
      `${keycap} ${keycap}`,
      `${acute}${acute}x`,
      "\u{1f600}\u{1f600}\u{1f600}",
      `${family}${family}`,
      "ＡＢＣ กิ้",
      "\u{1f9d1}‍\u{1f4bb} \u{1f3f3}️‍\u{1f308} \u{1f1fa}\u{1f1f8}\u{1f1ec}\u{1f1e7}",
    ]
    const seen = await Promise.all(texts.map(async (text) => [text, await drawn(text)] as const))
    for (const [text, width] of seen) expect([text, cells(text)]).toEqual([text, width])
  })
})
