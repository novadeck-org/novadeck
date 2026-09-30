import { context, describe, expect, it } from "../../../test"
import planV1 from "./fixtures/plan-v1.md?raw"
import {
  addColumn,
  addRow,
  addRowNote,
  cellSource,
  findTables,
  removeColumn,
  removeRow,
  setRowNote,
} from "./tables"

const plan = planV1
const edit = (text: string, from: number, to: number, insert: string): string =>
  text.slice(0, from) + insert + text.slice(to)

describe("plan tables", () => {
  context("when a plan has a table", () => {
    const [table] = findTables(plan)

    it("finds its rows, header first, without the delimiter row", () => {
      expect(table!.rows.map((row) => row.map((cell) => cell.text))).toEqual([
        ["Page", "What it needs to do"],
        ["Home", "Introduce the practice and lead into three selected projects."],
        ["Project", "Show the brief, approach, and outcome with a generous image layout."],
        ["About", "Explain how the studio works and offer a simple contact link."],
      ])
    })

    it("places each cell on its text", () => {
      const cell = table!.rows[2]![0]!
      expect(plan.slice(cell.from, cell.to)).toBe("Project")
    })

    it("changes only that cell when one is edited", () => {
      const cell = table!.rows[1]![0]!
      const edited = edit(plan, cell.from, cell.to, cellSource("Landing"))
      expect(edited).toBe(plan.replace("| Home    |", "| Landing    |"))
    })
  })

  context("when cells are unusual", () => {
    it("reads escaped pipes and escapes new ones", () => {
      const [table] = findTables("| a \\| b | c |\n| --- | --- |\n")
      expect(table!.rows[0]![0]!.text).toBe("a | b")
      expect(cellSource("x | y\nz")).toBe("x \\| y z")
    })

    it("puts an empty cell's text inside its padding", () => {
      const text = "| a | b |\n| --- | --- |\n| c |  |\n"
      const cell = findTables(text)[0]!.rows[1]![1]!
      expect(edit(text, cell.from, cell.to, "d")).toBe("| a | b |\n| --- | --- |\n| c | d |\n")
    })

    it("ignores pipes in code blocks and lines without a delimiter row", () => {
      expect(findTables("```\n| a | b |\n| --- | --- |\n```\n\na | b\n")).toEqual([])
    })
  })
})

const apply = (
  text: string,
  changes: readonly { from: number; to: number; insert: string }[],
): string =>
  changes
    .toSorted((a, b) => b.from - a.from)
    .reduce(
      (result, change) => result.slice(0, change.from) + change.insert + result.slice(change.to),
      text,
    )

describe("plan table shape", () => {
  const text =
    "Before\n\n| Page | Why |\n| --- | :-: |\n| Home | Lead in |\n| About | Contact |\n\nAfter\n"
  const table = findTables(text)[0]!

  context("when a row is added", () => {
    it("goes after the row it follows, empty, leaving the others as written", () => {
      expect(apply(text, [addRow(table, 1)])).toBe(
        "Before\n\n| Page | Why |\n| --- | :-: |\n| Home | Lead in |\n| | |\n| About | Contact |\n\nAfter\n",
      )
    })

    it("goes first in the body after the header", () => {
      expect(
        findTables(apply(text, [addRow(table, 0)]))[0]!.rows[1]!.map((cell) => cell.text),
      ).toEqual(["", ""])
    })
  })

  context("when a row is removed", () => {
    it("takes its line and nothing else", () => {
      expect(apply(text, [removeRow(table, 1)!])).toBe(
        "Before\n\n| Page | Why |\n| --- | :-: |\n| About | Contact |\n\nAfter\n",
      )
    })

    it("keeps the header", () => {
      expect(removeRow(table, 0)).toBeNull()
    })
  })

  context("when a column is added or removed", () => {
    it("adds an empty column with its delimiter, keeping alignment marks", () => {
      expect(apply(text, addColumn(table, 0))).toBe(
        "Before\n\n| Page | | Why |\n| --- | --- | :-: |\n| Home | | Lead in |\n| About | | Contact |\n\nAfter\n",
      )
    })

    it("removes a column's cells and one pipe per row", () => {
      expect(apply(text, removeColumn(table, 0))).toBe(
        "Before\n\n| Why |\n| :-: |\n| Lead in |\n| Contact |\n\nAfter\n",
      )
    })

    it("keeps the last column", () => {
      expect(removeColumn(findTables(apply(text, removeColumn(table, 0)))[0]!, 0)).toEqual([])
    })
  })
})

describe("plan table row notes", () => {
  const text = "| Page | Why |\n| --- | --- |\n| Home | Lead in |\n| About | Contact |\n"
  const table = findTables(text)[0]!

  context("when a row gets a note", () => {
    const added = addRowNote(table, 2)!
    const withNote = apply(text, [added.change])

    it("goes at the end of the row's last cell, leaving the row whole", () => {
      expect(withNote).toBe(
        "| Page | Why |\n| --- | --- |\n| Home | Lead in |\n| About | Contact <!-- novadeck:  --> |\n",
      )
      expect(findTables(withNote)[0]!.rows[2]!.map((cell) => cell.text)).toEqual([
        "About",
        "Contact",
      ])
    })

    it("puts the caret inside the note", () => {
      expect(withNote.slice(added.caret, added.caret + 4)).toBe(" -->")
    })

    it("stays out of cell edits", () => {
      const noted = findTables(withNote)[0]!
      const cell = noted.rows[2]![1]!
      expect(apply(withNote, [{ from: cell.from, to: cell.to, insert: "Email" }])).toContain(
        "| About | Email <!-- novadeck:  --> |",
      )
    })
  })

  context("when a row's note is written or emptied", () => {
    const noted = "| Page | Why |\n| --- | --- |\n| About | Contact <!-- novadeck: Old --> |\n"
    const notedTable = findTables(noted)[0]!

    it("reads it, with escaped pipes as pipes", () => {
      expect(findTables(noted.replace("Old", "a \\| b"))[0]!.notes[1]!.text).toBe("a | b")
    })

    it("writes its text, escaping pipes so the row keeps its cells", () => {
      const written = apply(noted, [setRowNote(notedTable, 1, "Email | phone")!])
      expect(written).toContain("<!-- novadeck: Email \\| phone -->")
      expect(findTables(written)[0]!.rows[1]!.map((cell) => cell.text)).toEqual([
        "About",
        "Contact",
      ])
    })

    it("keeps the row's comment closed whatever `-->` it's given", () => {
      expect(apply(noted, [setRowNote(notedTable, 1, "use ---> here")!])).toContain(
        "<!-- novadeck: use -> here -->",
      )
    })

    it("removes it and the space before it once empty", () => {
      expect(apply(noted, [setRowNote(notedTable, 1, " ")!])).toBe(
        "| Page | Why |\n| --- | --- |\n| About | Contact |\n",
      )
    })
  })

  context("when a note follows the table", () => {
    it("ends the table there", () => {
      const after = findTables(
        "| a | b |\n| --- | --- |\n| c | d |\n<!-- novadeck: x | y -->\n",
      )[0]!
      expect(after.rows).toHaveLength(2)
    })
  })

  context("when a line with a pipe is underlined", () => {
    it("reads a heading, not a table, unless the underline has a cell for each column", () => {
      expect(findTables("Use `a | b` here\n---\n")).toEqual([])
      expect(findTables("| a | b |\n| --- |\n| c | d |\n")).toEqual([])
    })
  })
})
