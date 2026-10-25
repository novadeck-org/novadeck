import { describe, expect, it } from "vitest"

import { ligatureRuns } from "./ligatures.js"

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
    expect(ligatureRuns("x " + "-".repeat(40) + " y")).toEqual([[2, 42]])
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
})
