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

  it("counts the lines cut short", () => {
    expect(tableOf("wide.csv", ["a,b", `1,${"x".repeat(4094)}`, "2,y"], 1).cut).toBe(1)
  })

  it("ends a quoted field cut short with its line, not swallowing the rows after", () => {
    const table = tableOf("notes.csv", ["h1,h2", `a,"${"x".repeat(4094)}`, "b,2", "c,3"], 1)
    expect(table.rows.map((row) => row.cells[0])).toEqual(["a", "b", "c"])
  })

  it("reads a quote never closed as text, rather than run every row into one", () => {
    const lines = [
      "size\tname",
      '"12 inch\tscreen',
      ...Array.from({ length: 30 }, (_, at) => `${at}\tx`),
    ]
    const table = tableOf("sizes.tsv", lines, 1, { whole: true })
    expect(table.rows).toHaveLength(31)
    expect(table.rows[0]!.cells).toEqual(['"12 inch', "screen"])
  })

  it("keeps quoting where only part is shown, ending the field the part cut off", () => {
    const lines = [
      "id,note,n",
      ...Array.from({ length: 30 }, (_, at) => `${at},"a, b",${at}`),
      '31,"a long note',
      ...Array.from({ length: 30 }, (_, at) => `that runs on, line ${at}`),
    ]
    const table = tableOf("notes.csv", lines, 1)
    expect(table.rows[0]!.cells).toEqual(["0", "a, b", "0"])
    expect(table.rows).toHaveLength(31)
    expect(table.rows.at(-1)!.cells[1]).toMatch(/^a long note\nthat runs on, line 0/)
  })

  it("spans a row over the lines its fields break across", () => {
    const table = tableOf("notes.csv", ["id,text", '1,"one', "two", 'three"', "2,x"], 1)
    expect(table.rows.map((row) => [row.line, row.last])).toEqual([
      [2, 4],
      [5, 5],
    ])
  })

  it("reads each column's decimal mark from its numbers", () => {
    const dots = tableOf("prices.csv", ["name;price", "a;1.5", "b;10.25", "c;1.25"], 1)
    expect(dots.numeric).toEqual([false, true])
    expect(
      sortRows(dots, { column: 1, direction: "ascending" }).map((row) => row.cells[1]),
    ).toEqual(["1.25", "1.5", "10.25"])
    const commas = tableOf("prices.tsv", ["name\tprice", "a\t1,5", "b\t10,25"], 1)
    expect(commas.numeric).toEqual([false, true])
    expect(commas.decimals[1]).toBe("comma")
  })

  it("reads decimal commas in a file split by semicolons", () => {
    const table = tableOf("prices.csv", ["item;price", "tea;1,5", "cake;12,25"], 1)
    expect(table.numeric).toEqual([false, true])
    expect(
      sortRows(table, { column: 1, direction: "descending" }).map((row) => row.cells[1]),
    ).toEqual(["12,25", "1,5"])
  })

  context("when the lines start past the file's first", () => {
    it("leaves out the tail of a record whose quote opened above them", () => {
      const table = tableOf("notes.csv", ['twice, see ticket",shipped', "1,a,b,c", "2,d,e,f"], 41)
      expect(table.rows.map((row) => row.line)).toEqual([42, 43])
    })

    it("starts at the first whole record, past the tail of one before", () => {
      const table = tableOf("notes.csv", ['",5', "b,2", 'c,"q"', "d,4"], 41)
      expect(table.rows.map((row) => [row.line, ...row.cells])).toEqual([
        [42, "b", "2"],
        [43, "c", "q"],
        [44, "d", "4"],
      ])
    })

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
    expect(
      ["42", "-3.5", "+1", "1,234,567.8", ".5", "2e3", "12%", " 7 "].map((cell) => numberOf(cell)),
    ).toEqual([42, -3.5, 1, 1234567.8, 0.5, 2000, 12, 7])
  })

  it("reads a decimal comma where the file is split by semicolons", () => {
    expect(
      ["1,5", "-2,25", "1.234,5", "1 234", "3"].map((cell) => numberOf(cell, "comma")),
    ).toEqual([1.5, -2.25, 1234.5, 1234, 3])
  })

  it("keeps digits led by a zero as text, as an ID's", () => {
    expect(["00123", "-012", "0", "0.5"].map((cell) => numberOf(cell))).toEqual([
      undefined,
      undefined,
      0,
      0.5,
    ])
  })

  it("isn't text, dates, or digits grouped wrong", () => {
    expect(
      ["", "-", "abc", "2026-11-18", "1,23", "12px", "0x1F"].map((cell) => numberOf(cell)),
    ).toEqual(Array(7).fill(undefined))
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

  it("keeps the file's order unsorted, or by a column the file no longer has", () => {
    expect(sortRows(table, null)).toBe(table.rows)
    expect(sortRows(table, { column: 9, direction: "ascending" })).toBe(table.rows)
  })
})

describe("what a table shows of its file", () => {
  it("says nothing of a file shown whole", () => {
    expect(
      partText({ firstLine: 1, count: 5, total: 5, truncated: false, named: true, cut: 0 }),
    ).toBeUndefined()
  })

  it("says when the lines pointed at are past the file's end", () => {
    expect(
      partText({
        firstLine: 1,
        count: 5,
        total: 5,
        truncated: false,
        named: true,
        cut: 0,
        clamped: 5,
      }),
    ).toBe("The lines pointed at are past its end, line 5.")
  })

  it("says when lines were cut short", () => {
    expect(
      partText({ firstLine: 1, count: 5, total: 5, truncated: false, named: true, cut: 2 }),
    ).toBe("2 lines are too long to show whole, so their last cells are missing.")
    expect(
      partText({ firstLine: 1, count: 400, total: 900, truncated: false, named: true, cut: 1 }),
    ).toBe(
      "Only part of the file is shown: lines 1–400 of 900. One line is too long to show whole, so its last cells are missing.",
    )
  })

  it("says plainly which lines of how many it shows", () => {
    expect(
      partText({ firstLine: 1, count: 400, total: 12034, truncated: false, named: true, cut: 0 }),
    ).toBe("Only part of the file is shown: lines 1–400 of 12,034.")
    expect(
      partText({ firstLine: 1, count: 400, total: null, truncated: true, named: true, cut: 0 }),
    ).toBe("Only part of the file is shown: lines 1–400 of a longer file.")
    expect(
      partText({ firstLine: 960, count: 81, total: 5000, truncated: false, named: false, cut: 0 }),
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
