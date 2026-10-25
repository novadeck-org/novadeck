// @vitest-environment node
import { beforeAll, describe, expect, it } from "vitest"

import { loadShaper, type Shaper } from "./ligature-font.test-kit.js"
import { ligatureWords } from "./ligature-table.js"
import { ligatureRuns } from "./ligatures.js"

// The ligature table against the font it was read from: the bundled JetBrains Mono's own
// substitution rules, run in Node. A font upgrade that changes a ligature fails here until
// `pnpm run ligature-table` makes the table again.

let shape: Shaper
beforeAll(async () => {
  shape = await loadShaper()
})

const cellsOf = (ranges: readonly (readonly [number, number])[]): number[] =>
  ranges.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i))

// A small deterministic generator, so a failure repeats.
const generator = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  return seed / 2 ** 32
}

// The two things a joiner must hold for the font: every cell it draws as part of a ligature
// is in a run, and a run drawn alone joins the same cells as it did in its line.
const check = (line: string): string | undefined => {
  const runs = ligatureRuns(line)
  const inRun = new Set(cellsOf(runs))
  const wanted = cellsOf(shape(line))
  const missing = wanted.find((cell) => !inRun.has(cell))
  if (missing !== undefined)
    return `${JSON.stringify(line)}: cell ${missing} joins and no run has it`
  for (const [from, to] of runs) {
    const alone = cellsOf(shape(line.slice(from, to))).map((cell) => cell + from)
    const inLine = wanted.filter((cell) => cell >= from && cell < to)
    if (alone.join() !== inLine.join())
      return `${JSON.stringify(line)}: run ${from}-${to} joins ${alone} alone, ${inLine} in its line`
  }
  return undefined
}

describe("the ligature table and the bundled font", () => {
  it("lists only sequences the font draws whole", () => {
    for (const word of ligatureWords) expect(shape(word), word).toEqual([[0, word.length]])
  })

  it("covers every cell the font joins, in every line of two or three of its glyphs", () => {
    const alphabet = [...new Set(ligatureWords.join(""))]
    const lines: string[] = []
    for (const a of alphabet)
      for (const b of alphabet) {
        lines.push(a + b)
        for (const c of alphabet) lines.push(a + b + c)
      }
    const failures = lines.map(check).filter(Boolean)
    expect(failures.slice(0, 5)).toEqual([])
  })

  it("holds in random code-like lines and long repeated runs", () => {
    const alphabet = [...new Set(ligatureWords.join(""))]
    const filler = [..."abcxyz019 ,;()"]
    const random = generator(20261025)
    const pick = (from: readonly string[]): string => from[Math.floor(random() * from.length)] ?? ""
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) {
      const length = 4 + Math.floor(random() * 20)
      const mix = i % 2 === 0 ? alphabet : [...alphabet, ...filler, " ", " "]
      lines.push(Array.from({ length }, () => pick(mix)).join(""))
    }
    for (const glyph of alphabet)
      for (const n of [5, 8, 11, 14, 17, 20, 23, 31, 33, 64, 100, 200]) lines.push(glyph.repeat(n))
    // Long lines are cut into runs; a cut inside a repeat shapes the same either side.
    lines.push("[" + "=".repeat(150) + ">" + " ".repeat(20) + "] 77%", "|" + "---|".repeat(60))
    const failures = lines.map(check).filter(Boolean)
    expect(failures.slice(0, 5)).toEqual([])
  })
})
