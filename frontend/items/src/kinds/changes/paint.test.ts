import { describe, expect, it } from "vitest"

import { segmentsOf } from "./paint"

describe("a line's pieces", () => {
  it("is the line as one piece without runs or marks", () => {
    expect(segmentsOf("const a = 1", undefined, [])).toEqual([
      { text: "const a = 1", classes: "", marked: false },
    ])
  })

  it("has a piece for each run of the highlight", () => {
    const runs = [
      { text: "const", from: 0, classes: "tok-keyword" },
      { text: " a = ", from: 5, classes: "" },
      { text: "1", from: 10, classes: "tok-number" },
    ]
    expect(segmentsOf("const a = 1", runs, []).map((piece) => [piece.text, piece.classes])).toEqual(
      [
        ["const", "tok-keyword"],
        [" a = ", ""],
        ["1", "tok-number"],
      ],
    )
  })

  it("cuts a run where a mark starts and ends, and keeps the run's classes on both parts", () => {
    const runs = [{ text: "export const", from: 0, classes: "tok-keyword" }]
    expect(segmentsOf("export const", runs, [[7, 12]])).toEqual([
      { text: "export ", classes: "tok-keyword", marked: false },
      { text: "const", classes: "tok-keyword", marked: true },
    ])
  })

  it("has no pieces for an empty line", () => {
    expect(segmentsOf("", undefined, [])).toEqual([])
  })
})
