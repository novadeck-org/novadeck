import { describe, expect, it } from "vitest"

import { hasTable, ligatureRuns, maxRunCells, runLimit } from "./ligatures.js"

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
    const lines = [
      ..."=-.#_/~*:".split("").map((glyph) => glyph.repeat(300)),
      "|" + "---|".repeat(60),
      "[" + "=".repeat(150) + ">" + " ".repeat(20) + "] 77%",
      "x " + "<!--".repeat(40) + " y",
    ]

    it.each(lines)("is drawn in runs no wider than the cap: %s", (line) => {
      for (const limit of [maxRunCells, 4, 9, 20])
        for (const [from, to] of ligatureRuns(line, limit)) {
          expect(to - from).toBeLessThanOrEqual(limit)
          // Never a lone cell, which joins nothing.
          expect(to - from).toBeGreaterThanOrEqual(2)
        }
    })

    it.each(lines)("is covered end to end as it would be in one run: %s", (line) => {
      const whole = ligatureRuns(line, 100_000)
      const cells = (runs: [number, number][]) =>
        new Set(runs.flatMap(([from, to]) => Array.from({ length: to - from }, (_, i) => from + i)))
      expect(cells(ligatureRuns(line))).toEqual(cells(whole))
    })

    it("is cut inside a repeated glyph, where the font draws the same piece either side", () => {
      const line = "[" + "=".repeat(150) + ">"
      const runs = ligatureRuns(line)
      expect(runs.length).toBeGreaterThan(1)
      for (const [, to] of runs.slice(0, -1)) {
        expect(line.slice(to - 2, to + 2)).toBe("====")
      }
    })

    it("takes a narrower cap where a cell has more device pixels", () => {
      expect(runLimit(7)).toBe(maxRunCells)
      expect(runLimit(15)).toBe(maxRunCells)
      expect(runLimit(23)).toBe(20)
      expect(runLimit(1000)).toBe(4)
      // A glyph of that many cells stays under the 512 px that sends one to the overflow page.
      for (const pixels of [7, 9, 11, 15, 23, 31])
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
