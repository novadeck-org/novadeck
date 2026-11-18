import { describe as context, describe, expect, it } from "vitest"

import { dataFormatOf, jsonErrorAt, parseData, type Parsed } from "./parse.js"

const errorOf = (parsed: Parsed) => {
  if (parsed.ok) throw new Error("it parsed")
  return parsed.error
}

const rootsOf = (parsed: Parsed) => {
  if (!parsed.ok) throw new Error(`didn't parse: ${parsed.error.message}`)
  return parsed.roots
}

describe("dataFormatOf", () => {
  it("knows JSON, JSONL and YAML by their extensions, in any case", () => {
    expect(dataFormatOf("a/package.json")).toBe("json")
    expect(dataFormatOf("rollout.JSONL")).toBe("jsonl")
    expect(dataFormatOf("events.ndjson")).toBe("jsonl")
    expect(dataFormatOf("ci.yml")).toBe("yaml")
    expect(dataFormatOf("compose.yaml")).toBe("yaml")
  })

  it("reads nothing else, nor a folder's dot", () => {
    expect(dataFormatOf("notes.md")).toBeUndefined()
    expect(dataFormatOf("a.json/README")).toBeUndefined()
    expect(dataFormatOf("json")).toBeUndefined()
  })
})

describe("parseData", () => {
  context("JSON", () => {
    it("reads the file as one unnamed value, starting at its first line", () => {
      expect(rootsOf(parseData('{"a": [1, true, null]}', "json", { firstLine: 3 }))).toEqual([
        { kind: "value", label: null, line: 3, value: { a: [1, true, null] } },
      ])
    })

    it("says where it stops reading, by line and column", () => {
      const parsed = parseData('{\n  "a": 1,\n  "b": }\n', "json")
      expect(parsed).toEqual({
        ok: false,
        error: { message: 'Expected a value, found "}"', line: 3, column: 8 },
      })
    })

    it("says a text cut short ends too soon", () => {
      expect(errorOf(parseData('{\n  "a": [1, 2', "json")).message).toBe(
        "Expected ',' or ']' after a value, found the end",
      )
    })
  })

  context("JSONL", () => {
    it("reads each line as a record named by its line, skipping blank ones", () => {
      const roots = rootsOf(parseData('{"n":1}\n\n[2]\n', "jsonl", { firstLine: 10 }))
      expect(roots).toEqual([
        { kind: "value", label: "Line 10", line: 10, value: { n: 1 } },
        { kind: "value", label: "Line 12", line: 12, value: [2] },
      ])
    })

    it("keeps a record that doesn't read as broken, with why, and reads on", () => {
      const roots = rootsOf(parseData('{"n":1}\n{"n":\n{"n":3}', "jsonl"))
      expect(roots.map((root) => root.kind)).toEqual(["value", "broken", "value"])
      expect(roots[1]).toMatchObject({
        label: "Line 2",
        text: '{"n":',
        reason: "Expected a value, found the end, at column 6",
      })
    })

    it("says a record as long as the longest line may be was cut short", () => {
      const long = `{"text":"${"x".repeat(20)}`
      const roots = rootsOf(parseData(long, "jsonl", { longest: long.length }))
      expect(roots[0]).toMatchObject({
        kind: "broken",
        reason: `Cut short at ${long.length} characters`,
      })
    })

    it("reads Windows line breaks", () => {
      expect(rootsOf(parseData('{"a":1}\r\n{"b":2}\r\n', "jsonl"))).toHaveLength(2)
    })
  })

  context("YAML", () => {
    it("reads one document as one unnamed value, aliases resolved and merge keys merged", () => {
      const text = "base: &base\n  image: node\nbuild:\n  <<: *base\n  run: test\nsame: *base\n"
      expect(rootsOf(parseData(text, "yaml"))).toEqual([
        {
          kind: "value",
          label: null,
          line: 1,
          value: {
            base: { image: "node" },
            build: { image: "node", run: "test" },
            same: { image: "node" },
          },
        },
      ])
    })

    it("names each of several documents, at the line it starts", () => {
      const roots = rootsOf(parseData("a: 1\n---\nb: 2\n---\n- 3\n", "yaml"))
      expect(roots.map((root) => [root.label, root.line])).toEqual([
        ["Document 1", 1],
        ["Document 2", 2],
        ["Document 3", 4],
      ])
      expect(roots.map((root) => root.kind === "value" && root.value)).toEqual([
        { a: 1 },
        { b: 2 },
        [3],
      ])
    })

    it("says where it stops reading, counting from the first line it was given", () => {
      const error = errorOf(parseData("a: 1\nb: [1, 2\nc: 3\n", "yaml", { firstLine: 5 }))
      expect(error.line).toBeGreaterThanOrEqual(6)
    })

    it("refuses an alias it has no anchor for", () => {
      expect(errorOf(parseData("a: *missing\n", "yaml"))).toMatchObject({ line: 1 })
    })

    it("refuses aliases that blow up past a bound", () => {
      const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]']
      for (const name of "bcdefgh") {
        const previous = String.fromCharCode(name.charCodeAt(0) - 1)
        lines.push(`${name}: &${name} [${Array(9).fill(`*${previous}`).join(",")}]`)
      }
      expect(parseData(lines.join("\n"), "yaml").ok).toBe(false)
    })

    it("reads an empty file as nothing", () => {
      expect(rootsOf(parseData("", "yaml"))).toEqual([])
    })
  })
})

describe("jsonErrorAt", () => {
  it("finds a trailing comma, a bare key and an unknown escape", () => {
    expect(jsonErrorAt("[1, 2,]")).toEqual({ offset: 6, message: 'Expected a value, found "]"' })
    expect(jsonErrorAt("{a: 1}")).toEqual({
      offset: 1,
      message: 'Expected a key in quotes, found "a"',
    })
    expect(jsonErrorAt('"\\q"')).toEqual({ offset: 2, message: "A string holds an unknown escape" })
  })

  it("finds what follows a whole value", () => {
    expect(jsonErrorAt("{} {}")).toEqual({ offset: 3, message: 'Expected the end, found "{"' })
  })
})
