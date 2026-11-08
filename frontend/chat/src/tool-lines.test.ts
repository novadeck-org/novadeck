import type { ToolOutcome } from "@novadeck/core/conversation"
import type { ToolEntry } from "@novadeck/core/conversation/turns"

import { describe, expect, it } from "./test"
import {
  failedCount,
  foldSummary,
  moreChanged,
  runningVerb,
  toolLines,
  toolNote,
  verbOf,
} from "./tool-lines"

const outcome = (fields: Partial<ToolOutcome>): ToolOutcome => ({
  failed: false,
  exit: null,
  running: false,
  size: null,
  change: null,
  opening: false,
  ...fields,
})

const entry = (fields: Partial<ToolEntry> = {}): ToolEntry => ({
  id: "1",
  call: "1",
  tool: "Bash",
  run: { kind: "run", title: "Ran", detail: "pnpm test" },
  input: "{}",
  truncated: false,
  result: { id: "1:result", text: "ok", truncated: false },
  outcome: null,
  scripted: false,
  ...fields,
})

describe("a tool line's words", () => {
  it("says a decoder's title as a line does, a name in capitals as it is", () => {
    expect(verbOf("Ran")).toBe("ran")
    expect(verbOf("Listed MCP resources")).toBe("listed MCP resources")
    expect(verbOf("MCP tool")).toBe("MCP tool")
    expect(verbOf("mcp__linear__get_issue")).toBe("mcp__linear__get_issue")
    expect(verbOf("TeamCreate")).toBe("TeamCreate")
  })

  it("has a word of its own only for a command that still goes", () => {
    expect(runningVerb({ kind: "run", title: "Ran", detail: "" })).toBe("running")
    expect(runningVerb({ kind: "run", title: "Waited", detail: "" })).toBe("waited")
    expect(runningVerb({ kind: "read", title: "Read", detail: "" })).toBe("read")
  })
})

describe("what came of a call", () => {
  const change = { added: 2, removed: 1, lines: [] }

  it("says nothing where its harness doesn't", () => {
    expect(toolNote(entry())).toBeNull()
    expect(toolNote(entry({ outcome: outcome({}) }))).toBeNull()
  })

  it("gives a failed command's code, and a failure with none in a word", () => {
    expect(toolNote(entry({ outcome: outcome({ failed: true, exit: 1 }) }))).toEqual({
      kind: "failed",
      text: "exit 1",
    })
    for (const exit of [null, 0])
      expect(toolNote(entry({ outcome: outcome({ failed: true, exit }) }))).toEqual({
        kind: "failed",
        text: "failed",
      })
  })

  it("takes a code other than 0 as a failure only where the harness says nothing of it", () => {
    expect(toolNote(entry({ outcome: outcome({ failed: null, exit: 2 }) }))?.kind).toBe("failed")
    expect(toolNote(entry({ outcome: outcome({ failed: false, exit: 1 }) }))).toBeNull()
  })

  it("counts an edit's lines, and a failure outranks them", () => {
    expect(toolNote(entry({ outcome: outcome({ change }) }))).toEqual({
      kind: "change",
      added: 2,
      removed: 1,
    })
    expect(toolNote(entry({ outcome: outcome({ failed: true, change }) }))?.kind).toBe("failed")
  })

  it("never says a call past its result still runs, only where it went", () => {
    expect(toolNote(entry({ outcome: outcome({ failed: null, running: true }) }))).toEqual({
      kind: "said",
      text: "in the background",
    })
  })

  it.each([
    [1, "line", "1 line"],
    [6, "line", "6 lines"],
    [1, "match", "1 match"],
    [3, "match", "3 matches"],
    [2, "file", "2 files"],
  ] as const)("counts %i %s", (count, unit, text) => {
    expect(toolNote(entry({ outcome: outcome({ size: { count, unit } }) }))).toEqual({
      kind: "said",
      text,
    })
  })

  it("says nothing of a subagent having ended: a result may only say it started", () => {
    expect(toolNote(entry({ run: { kind: "agent", title: "Subagent", detail: "x" } }))).toBeNull()
  })
})

describe("counting", () => {
  it("counts the calls that failed", () => {
    expect(
      failedCount([
        entry(),
        entry({ outcome: outcome({ failed: true, exit: 1 }) }),
        entry({ outcome: outcome({ failed: true }) }),
      ]),
    ).toBe(2)
  })

  it("counts what a change has past the lines it carries, kept lines aside", () => {
    const lines = [
      { sign: "-", text: "a", line: 1 },
      { sign: " ", text: "b", line: 2 },
    ] as const
    expect(moreChanged({ added: 3, removed: 1, lines })).toBe(3)
    expect(moreChanged({ added: 0, removed: 1, lines })).toBe(0)
  })
})

describe("a folded run's line", () => {
  const read = { kind: "read", title: "Read", detail: "" } as const
  const search = { kind: "search", title: "Searched", detail: "" } as const

  it("counts a title that came more than once, in the order they came", () => {
    expect(
      foldSummary([
        entry({ run: read }),
        entry({ run: search }),
        entry({ run: read }),
        entry({ run: read }),
      ]),
    ).toBe("read ×3, searched")
  })

  it("names four kinds at most", () => {
    const titled = (title: string) => entry({ run: { ...read, title } })
    expect(foldSummary(["A", "B", "C", "D", "E"].map(titled)).split(", ")).toHaveLength(4)
  })
})

describe("calls made inside a script", () => {
  const line = (id: string, scripted = false) => entry({ id, scripted })

  it("fold under the call before them, in the order they came", () => {
    const lines = toolLines([line("a"), line("b"), line("c", true), line("d", true), line("e")])
    expect(
      lines.map(({ entry: { id }, scripted }) => [id, scripted.map((each) => each.id)]),
    ).toEqual([
      ["a", []],
      ["b", ["c", "d"]],
      ["e", []],
    ])
  })

  it("stand alone with no call before them", () => {
    const lines = toolLines([line("a", true), line("b", true)])
    expect(lines.map(({ scripted }) => scripted)).toEqual([[], []])
  })
})
