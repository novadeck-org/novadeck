import { describe, expect, it } from "vitest"

import { cutMargin, hasTable, ligatureRuns, maxRunCells, runLimit } from "./ligatures.js"

describe("ligatureRuns", () => {
  it("finds the sequences the font joins", () => {
    expect(ligatureRuns("a => b")).toEqual([[2, 4]])
    expect(ligatureRuns("x -> y, a != b, c === d")).toEqual([
      [2, 4],
      [10, 12],
      [18, 21],
    ])
    expect(ligatureRuns("<!-- note -->")).toEqual([
      [0, 4],
      [10, 13],
    ])
  })

  it("leaves a line with nothing to join alone", () => {
    expect(ligatureRuns("")).toEqual([])
    expect(ligatureRuns("plain words and (a, b)")).toEqual([])
    expect(ligatureRuns("a = b - c > d")).toEqual([])
  })

  it("takes a long run whole, as the font draws it", () => {
    expect(ligatureRuns("==========")).toEqual([[0, 10]])
    expect(ligatureRuns("x " + "-".repeat(30) + " y")).toEqual([[2, 32]])
    expect(ligatureRuns("<=====>")).toEqual([[0, 7]])
  })

  it("merges sequences that overlap or touch into one run", () => {
    // `=>` and `>=` share the `>`: one run, which the font shapes as it likes.
    expect(ligatureRuns("=>=")).toEqual([[0, 3]])
    expect(ligatureRuns("!==>")).toEqual([[0, 4]])
    expect(ligatureRuns("->->")).toEqual([[0, 4]])
  })

  it("finds each run in a line of several", () => {
    expect(ligatureRuns("if (a >= b && c !== d) { x => y }")).toEqual([
      [6, 8],
      [11, 13],
      [16, 19],
      [27, 29],
    ])
  })

  describe("a long line", () => {
    const cells = (runs: [number, number][]) =>
      new Set(runs.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)))
    const repeats = [
      ..."=-.#_/~*:".split("").map((glyph) => glyph.repeat(300)),
      "[" + "=".repeat(150) + ">" + " ".repeat(20) + "] 77%",
      "+" + "-".repeat(60) + "+",
    ]
    // Where no cut is safe, the font draws what a cut would break, so the line is not cut.
    const tangles = [
      "|" + "---|".repeat(60),
      "|" + "-----|".repeat(30),
      "-->".repeat(50),
      "=>".repeat(80),
      "x " + "<!--".repeat(40) + " y",
    ]

    it.each([...repeats, ...tangles])("is drawn in runs no wider than the cap: %s", (line) => {
      for (const limit of [maxRunCells, 9, 17, 20])
        for (const [from, to] of ligatureRuns(line, limit)) {
          expect(to - from).toBeLessThanOrEqual(limit)
          // Never a lone cell, which joins nothing.
          expect(to - from).toBeGreaterThanOrEqual(2)
        }
    })

    it.each(repeats)("is joined end to end, cut where the font would not change: %s", (line) => {
      expect(cells(ligatureRuns(line))).toEqual(cells(ligatureRuns(line, Infinity)))
    })

    it.each(tangles)("is left plain past the cap, never cut where it would change: %s", (line) => {
      // A run past the cap with no safe cut stays unjoined, whole.
      expect(ligatureRuns(line)).toEqual([])
      expect(ligatureRuns(line, Infinity).length).toBeGreaterThan(0)
    })

    it("is cut only deep inside a repeated glyph, never nearer its ends than the margin", () => {
      const line = "[" + "=".repeat(150) + ">"
      const runs = ligatureRuns(line)
      expect(runs.length).toBeGreaterThan(1)
      for (const [, to] of runs.slice(0, -1)) {
        expect(to - 1).toBeGreaterThanOrEqual(1 + cutMargin)
        expect(150 + 1 - to).toBeGreaterThanOrEqual(cutMargin)
      }
    })

    it("leaves the stretch to the next safe cut plain where none falls within the cap", () => {
      // Two repeats with a join between that no cut may fall in: the first fills the cap alone.
      const line = "=".repeat(20) + "|---|" + "=".repeat(40)
      const runs = ligatureRuns(line, 20)
      expect(runs.every(([from, to]) => to - from <= 20)).toBe(true)
      // Nothing crosses the tee's neighbourhood, whose glyphs a cut would change.
      expect(runs.some(([from, to]) => from < 22 && to > 22)).toBe(false)
    })

    it("takes a narrower cap where a cell has more device pixels, and none where too few fit", () => {
      expect(runLimit(7)).toBe(maxRunCells)
      expect(runLimit(15)).toBe(maxRunCells)
      expect(runLimit(23)).toBe(20)
      // A cap under the longest sequence joins nothing, rather than a run past 512 px.
      expect(runLimit(121)).toBe(0)
      expect(runLimit(1000)).toBe(0)
      expect(ligatureRuns("a => b", 0)).toEqual([])
      expect(ligatureRuns("a => b", 3)).toEqual([])
      // A glyph of that many cells stays under the 512 px that sends one to the overflow page.
      for (const pixels of [7, 9, 11, 15, 23, 31, 100])
        expect(runLimit(pixels) * pixels).toBeLessThan(512)
    })
  })

  it("owns the table only for JetBrains Mono", () => {
    expect(hasTable("'JetBrains Mono Variable', monospace")).toBe(true)
    expect(hasTable('"JetBrains Mono", Menlo')).toBe(true)
    expect(hasTable("JetBrains Mono")).toBe(true)
    expect(hasTable("'Share Tech Mono', 'JetBrains Mono Variable', monospace")).toBe(false)
    expect(hasTable("monospace")).toBe(false)
  })
})
