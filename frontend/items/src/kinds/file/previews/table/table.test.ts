import { context, describe, expect, it } from "../../../../test"
import { columnLetters, nextSort, numberOf, partText, sortRows, tableOf } from "./table"

const people = ["name,age,city", "Ann,34,Oslo", "bo,7,", "Cy,1200,Rome", "Di,,Bern"]

describe("a delimited file as a table", () => {
  it("takes its first row as the header, and pads short rows", () => {
    const table = tableOf("people.csv", ["a,b,c", "1,2", "x"], 1)
    expect(table.header).toEqual(["a", "b", "c"])
    expect(table.named).toBe(true)
    expect(table.rows.map((row) => row.cells)).toEqual([
      ["1", "2", ""],
      ["x", "", ""],
    ])
  })

  it("numbers each row by the line it starts on", () => {
    const table = tableOf("notes.csv", ["id,text", '1,"two', 'lines"', "2,one"], 1)
    expect(table.rows.map((row) => row.line)).toEqual([2, 4])
  })

  it("marks the columns whose filled cells are all numbers", () => {
    expect(tableOf("people.csv", people, 1).numeric).toEqual([false, true, false])
  })

  context("when the lines start past the file's first", () => {
    it("names the columns by letter, and every line is a row", () => {
      const table = tableOf("big.csv", ["Ann,34", "Bo,7"], 960)
      expect(table.named).toBe(false)
      expect(table.header).toEqual(["A", "B"])
      expect(table.rows.map((row) => row.line)).toEqual([960, 961])
    })
  })
})

describe("numbers in cells", () => {
  it("reads signs, groups, fractions, exponents and percents", () => {
    expect(["42", "-3.5", "+1", "1,234,567.8", ".5", "2e3", "12%", " 7 "].map(numberOf)).toEqual([
      42, -3.5, 1, 1234567.8, 0.5, 2000, 12, 7,
    ])
  })

  it("isn't text, dates, or digits grouped wrong", () => {
    expect(["", "-", "abc", "2026-11-18", "1,23", "12px", "0x1F"].map(numberOf)).toEqual(
      Array(7).fill(undefined),
    )
  })
})

describe("sorting a table", () => {
  const table = tableOf("people.csv", people, 1)
  const column = (sorted: ReturnType<typeof sortRows>, at: number) =>
    sorted.map((row) => row.cells[at])

  it("goes ascending, descending, then back to the file's order", () => {
    const first = nextSort(null, 1)
    expect(first).toEqual({ column: 1, direction: "ascending" })
    const second = nextSort(first, 1)
    expect(second).toEqual({ column: 1, direction: "descending" })
    expect(nextSort(second, 1)).toBeNull()
    expect(nextSort(second, 0)).toEqual({ column: 0, direction: "ascending" })
  })

  it("orders a numeric column by value, empty cells last either way", () => {
    expect(column(sortRows(table, { column: 1, direction: "ascending" }), 1)).toEqual([
      "7",
      "34",
      "1200",
      "",
    ])
    expect(column(sortRows(table, { column: 1, direction: "descending" }), 1)).toEqual([
      "1200",
      "34",
      "7",
      "",
    ])
  })

  it("orders text as people read it, whatever its case", () => {
    expect(column(sortRows(table, { column: 0, direction: "ascending" }), 0)).toEqual([
      "Ann",
      "bo",
      "Cy",
      "Di",
    ])
  })

  it("keeps the file's order unsorted", () => {
    expect(sortRows(table, null)).toBe(table.rows)
  })
})

describe("what a table shows of its file", () => {
  it("says nothing of a file shown whole", () => {
    expect(
      partText({ firstLine: 1, count: 5, total: 5, truncated: false, named: true }),
    ).toBeUndefined()
  })

  it("says plainly which lines of how many it shows", () => {
    expect(
      partText({ firstLine: 1, count: 400, total: 12034, truncated: false, named: true }),
    ).toBe("Only part of the file is shown: lines 1–400 of 12,034.")
    expect(partText({ firstLine: 1, count: 400, total: null, truncated: true, named: true })).toBe(
      "Only part of the file is shown: lines 1–400 of a longer file.",
    )
    expect(
      partText({ firstLine: 960, count: 81, total: 5000, truncated: false, named: false }),
    ).toBe("Only part of the file is shown: lines 960–1,040 of 5,000, without its header row.")
  })
})

describe("column letters", () => {
  it("count as a spreadsheet's do", () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702].map(columnLetters)).toEqual([
      "A",
      "B",
      "Z",
      "AA",
      "AB",
      "AZ",
      "BA",
      "ZZ",
      "AAA",
    ])
  })
})
