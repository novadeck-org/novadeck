import { describe as context, describe, expect, it } from "vitest"

import { copyText, countText, keyOf, pathText, previewText, rowsOf, scalarText } from "./model.js"
import { parseData, type DataRoot } from "./parse.js"

const lone = (value: unknown): DataRoot[] => [{ kind: "value", label: null, line: 1, value }]
const names = (rows: ReturnType<typeof rowsOf>) =>
  rows.map((row) => `${row.depth}:${String(row.name)}`)

describe("rowsOf", () => {
  context("a lone value", () => {
    it("shows an object's keys as the top rows, and opens the first level below them", () => {
      const rows = rowsOf(lone({ a: { b: { c: 1 } }, d: [1, 2] }), new Map())
      expect(names(rows)).toEqual(["0:a", "1:b", "0:d", "1:0", "1:1"])
      expect(rows.find((row) => row.name === "b")).toMatchObject({ open: false, count: 1 })
    })

    it("shows an empty object or array as its one row", () => {
      expect(rowsOf(lone({}), new Map())).toMatchObject([{ name: null, type: "object", count: 0 }])
      expect(rowsOf(lone([]), new Map())).toMatchObject([{ name: null, type: "array", count: 0 }])
    })

    it("shows a plain value as its one row", () => {
      expect(rowsOf(lone("hi"), new Map())).toMatchObject([
        { name: null, type: "string", value: "hi" },
      ])
    })

    it("leaves a big array closed even at the levels that open", () => {
      const rows = rowsOf(lone({ many: Array.from({ length: 101 }, (_, at) => at) }), new Map())
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({ name: "many", open: false, count: 101 })
    })

    it("follows what the person opened and closed", () => {
      const value = { a: { b: { c: 1 } }, d: [1] }
      const open = new Map([
        [keyOf(0, ["a", "b"]), true],
        [keyOf(0, ["d"]), false],
      ])
      expect(names(rowsOf(lone(value), open))).toEqual(["0:a", "1:b", "2:c", "0:d"])
    })

    it("says where each row sits among its siblings", () => {
      const rows = rowsOf(lone({ a: 1, b: 2, c: 3 }), new Map())
      expect(rows.map((row) => [row.position, row.siblings])).toEqual([
        [1, 3],
        [2, 3],
        [3, 3],
      ])
    })
  })

  context("records", () => {
    const records: DataRoot[] = [
      { kind: "value", label: "Line 1", line: 1, value: { type: "user" } },
      { kind: "broken", label: "Line 2", line: 2, text: '{"type":', reason: "Cut short" },
    ]

    it("shows one row per record, closed, when roots don't open", () => {
      const rows = rowsOf(records, new Map(), { roots: false, levels: 1, most: 100 })
      expect(rows.map((row) => [row.name, row.open, row.broken])).toEqual([
        ["Line 1", false, undefined],
        ["Line 2", false, "Cut short"],
      ])
    })

    it("opens a record the person opens, its keys a level in", () => {
      const rows = rowsOf(records, new Map([[keyOf(0, []), true]]), {
        roots: false,
        levels: 1,
        most: 100,
      })
      expect(names(rows)).toEqual(["0:Line 1", "1:type", "0:Line 2"])
    })
  })

  it("stays quick on a few thousand nodes", () => {
    const value = Array.from({ length: 5000 }, (_, at) => ({ id: at, name: `item ${at}` }))
    const open = new Map(value.map((_, at) => [keyOf(0, [at]), true]))
    const started = performance.now()
    const rows = rowsOf(lone(value), open)
    expect(rows).toHaveLength(15000)
    expect(performance.now() - started).toBeLessThan(200)
  })
})

describe("pathText", () => {
  it("writes paths as jq does", () => {
    expect(pathText([])).toBe(".")
    expect(pathText(["items", 0, "name"])).toBe(".items[0].name")
    expect(pathText([3, "a b", "ok"])).toBe('.[3]["a b"].ok')
    expect(pathText(["2fa"])).toBe('.["2fa"]')
  })
})

describe("copyText", () => {
  it("copies a string as its own text, anything else as indented JSON", () => {
    expect(copyText('say "hi"')).toBe('say "hi"')
    expect(copyText({ a: [1] })).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(copyText(null)).toBe("null")
    expect(copyText(Number.POSITIVE_INFINITY)).toBe("Infinity")
  })

  it("copies a large integer as written, alone or inside an object", () => {
    const parsed = parseData('{"id": 12345678901234567890}', "json")
    const value = parsed.ok && parsed.roots[0]?.kind === "value" ? parsed.roots[0].value : null
    expect(copyText((value as { id: unknown }).id)).toBe("12345678901234567890")
    expect(copyText(value)).toBe('{\n  "id": 12345678901234567890\n}')
    expect(scalarText((value as { id: unknown }).id)).toBe("12345678901234567890")
  })

  it("copies a value holding itself, as a YAML alias in its own anchor does, marking where", () => {
    const shared = { x: 1 }
    const looped: Record<string, unknown> = { shared, again: shared }
    looped["self"] = looped
    expect(JSON.parse(copyText(looped))).toEqual({
      shared: { x: 1 },
      again: { x: 1 },
      self: "[Circular]",
    })
  })
})

describe("scalarText", () => {
  it("never cuts an emoji in half", () => {
    expect(scalarText("ab😀cd", 3)).toBe('"ab…"')
  })

  it("quotes a string on one line, cutting a long one", () => {
    expect(scalarText("a\nb")).toBe('"a\\nb"')
    expect(scalarText("abcdef", 3)).toBe('"abc…"')
    expect(scalarText(false)).toBe("false")
  })
})

describe("previewText", () => {
  it("shows a closed node's first entries, nested ones folded", () => {
    expect(previewText({ type: "user", message: { a: 1 }, list: [], "a b": 1 })).toBe(
      '{type: "user", message: {…}, list: [], "a b": 1}',
    )
    expect(previewText([1, [2], {}])).toBe("[1, […], {}]")
  })

  it("stops at its budget", () => {
    expect(previewText({ alpha: 1, beta: 2, gamma: 3 }, 16)).toBe("{alpha: 1, …}")
  })
})

describe("countText", () => {
  it("counts keys and items, one or many", () => {
    expect(countText("object", 1)).toBe("1 key")
    expect(countText("array", 3)).toBe("3 items")
  })
})
