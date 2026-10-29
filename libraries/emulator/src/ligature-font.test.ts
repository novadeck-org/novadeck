// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest"

import { loadFont, type Font } from "./ligature-font.test-kit.js"
import { ligatureSequences } from "./ligature-table.js"
import { cutMargin, ligatureRuns } from "./ligatures.js"

// The ligature table against the font it was read from: the bundled JetBrains Mono's own
// substitution rules, run in Node. A font upgrade that changes a ligature fails here until
// `pnpm run ligature-table` makes the table again.

let font: Font
beforeAll(async () => {
  font = await loadFont()
})

const cellsOf = (ranges: readonly (readonly [number, number])[]): number[] =>
  ranges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i))

// A small deterministic generator, so a failure repeats.
const generator = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}

const widths = [4, 17, 20, 30, 32, Infinity]

// What a joiner must hold for the font, at every width of run it may be given:
// - drawn as the joiner cuts it, each run is the glyphs the font draws at those cells in the whole
//   line (the glyph ids, so a tee where a cut fell, or a pairing that flipped, fails);
// - no run is wider than the width;
// - without a width, every cell the font joins is in a run; with one, a cell the font joins is
//   either in a run or in a stretch the cap left plain, which is inside a run of the uncapped line.
const check = (line: string, limits = widths): string | undefined => {
  const whole = font.glyphs(line)
  const uncapped = ligatureRuns(line, Infinity)
  const inUncapped = new Set(cellsOf(uncapped))
  const joined = cellsOf(font.shape(line))
  const missing = joined.find((cell) => !inUncapped.has(cell))
  if (missing !== undefined)
    return `${JSON.stringify(line)}: cell ${missing} joins and no run has it`
  for (const limit of limits) {
    const runs = ligatureRuns(line, limit)
    const inRun = new Set(cellsOf(runs))
    for (const cell of inRun)
      if (!inUncapped.has(cell)) return `${JSON.stringify(line)}: width ${limit} joins cell ${cell}`
    for (const [from, to] of runs) {
      if (to - from > limit)
        return `${JSON.stringify(line)}: run ${from}-${to} is wider than ${limit}`
      const alone = font.glyphs(line.slice(from, to))
      const differs = alone.findIndex((glyph, i) => glyph !== whole[from + i])
      if (differs >= 0)
        return `${JSON.stringify(line)}: width ${limit}, run ${from}-${to} draws cell ${from + differs} as another glyph than in its line`
    }
    // Only a capped line leaves cells out, and only those of a run too wide.
    for (const [from, to] of uncapped)
      if (to - from <= limit)
        for (let cell = from; cell < to; cell++)
          if (!inRun.has(cell))
            return `${JSON.stringify(line)}: width ${limit} left cell ${cell} of a narrow run plain`
  }
  return undefined
}

const alphabet = (): string[] => [...new Set(ligatureSequences.join(""))]

// Rows the font draws with rules that reach further than a pair of glyphs.
const rows = [
  "|" + "---|".repeat(60),
  "|" + "-----|".repeat(30),
  "|:---|:---:|".repeat(20),
  "|" + "--|".repeat(60),
  "|" + "===|".repeat(60),
  "~-".repeat(60),
  "-|".repeat(60),
  "-->".repeat(50),
  "==>".repeat(50),
  "<-->".repeat(40),
  "##====".repeat(30),
  "=>".repeat(80),
  "->".repeat(80),
  "<!--".repeat(40),
  "+" + "-".repeat(40) + "+" + "-".repeat(40) + "+",
  "+" + "=".repeat(40) + "+",
  "<!-- " + "=".repeat(40) + " -->",
  "[" + "=".repeat(150) + ">" + " ".repeat(20) + "] 77%",
  "<" + "-".repeat(100) + ">",
  "x " + "=".repeat(60) + " y " + "-".repeat(60) + " z",
]

// The checks shape tens of thousands of lines, which a slow runner takes seconds over.
const slow = 60_000

describe("the ligature table and the bundled font", () => {
  it("lists only sequences the font draws whole", () => {
    for (const sequence of ligatureSequences)
      expect(font.shape(sequence), sequence).toEqual([[0, sequence.length]])
  })

  it(
    "covers every cell the font joins, in every line of two or three of its glyphs",
    () => {
      const glyphs = alphabet()
      const lines: string[] = []
      for (const a of glyphs)
        for (const b of glyphs) {
          lines.push(a + b)
          for (const c of glyphs) lines.push(a + b + c)
        }
      const failures = lines.map((line) => check(line, [Infinity])).filter(Boolean)
      expect(failures.slice(0, 5)).toEqual([])
    },
    slow,
  )

  it(
    "holds in random code-like lines and long repeated runs",
    () => {
      const glyphs = alphabet()
      const filler = [..."abcxyz019 ,;()"]
      const random = generator(20261025)
      const pick = (from: readonly string[]): string =>
        from[Math.floor(random() * from.length)] ?? ""
      const lines: string[] = []
      for (let i = 0; i < 800; i++) {
        const length = 4 + Math.floor(random() * 20)
        const mix = i % 2 === 0 ? glyphs : [...glyphs, ...filler, " ", " "]
        lines.push(Array.from({ length }, () => pick(mix)).join(""))
      }
      for (const glyph of glyphs)
        for (const n of [5, 11, 17, 33, 64, 200]) lines.push(glyph.repeat(n))
      const failures = lines.map((line) => check(line)).filter(Boolean)
      expect(failures.slice(0, 5)).toEqual([])
    },
    slow,
  )

  it(
    "draws a long line cut into runs as it draws it whole: tables, arrows, rules, bars",
    () => {
      const failures = rows.map((line) => check(line)).filter(Boolean)
      expect(failures.slice(0, 5)).toEqual([])
    },
    slow,
  )

  it(
    "draws long random mixes of stretches and sequences as it draws them whole",
    () => {
      const glyphs = alphabet()
      const random = generator(77)
      const pick = (from: readonly string[]): string =>
        from[Math.floor(random() * from.length)] ?? ""
      const lines: string[] = []
      for (let i = 0; i < 120; i++) {
        let line = ""
        while (line.length < 60 + random() * 160) {
          const roll = random()
          if (roll < 0.45) line += pick(glyphs).repeat(1 + Math.floor(random() * 30))
          else if (roll < 0.8) line += pick(ligatureSequences)
          else line += pick([..."ab 1", ...glyphs])
        }
        lines.push(line)
      }
      const failures = lines.map((line) => check(line)).filter(Boolean)
      expect(failures.slice(0, 5)).toEqual([])
    },
    slow,
  )

  it(
    "draws every cut the joiner makes the same either side: the margin holds for every glyph",
    () => {
      const glyphs = alphabet()
      const random = generator(5)
      const pick = (): string =>
        [...glyphs, ..."ab 1"][Math.floor(random() * (glyphs.length + 4))] ?? ""
      const around = (): string => Array.from({ length: Math.floor(random() * 5) }, pick).join("")
      const failures: string[] = []
      for (const glyph of glyphs)
        for (let i = 0; i < 12; i++) {
          const before = around()
          const line = before + glyph.repeat(30) + around()
          const whole = font.glyphs(line)
          for (const at of [
            before.length + cutMargin,
            before.length + 15,
            before.length + 30 - cutMargin,
          ]) {
            const left = font.glyphs(line.slice(0, at))
            const right = font.glyphs(line.slice(at))
            const same =
              left.every((g, k) => g === whole[k]) && right.every((g, k) => g === whole[at + k])
            if (!same) failures.push(`${JSON.stringify(line)} cut at ${at}`)
          }
        }
      expect(failures.slice(0, 5)).toEqual([])
    },
    slow,
  )

  // Known limit: the table lists the glyphs a ligature joins, not the neighbour that stops one,
  // so these draw an arrow on WebGL where the font draws plain. They fail until the table can
  // say so; this records that they do.
  it.fails.each(["<-1>", "[--->", "a <-1> b"])("draws %s as the font does", (line) => {
    expect(check(line)).toBeUndefined()
  })
})
