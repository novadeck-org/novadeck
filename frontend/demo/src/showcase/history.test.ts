import { describe, expect, it } from "../test"
import { contentOf, diffOf, rangeOf, type History } from "./history"

const history = (steps: History["steps"], start: History["start"] = {}): History => ({
  root: "/repo",
  base: "main",
  start,
  steps,
})
const lines = (...rows: string[]) => `${rows.join("\n")}\n`

describe("the layers of a history", () => {
  it("are the steps newest first, each with the files it changed and their lines", () => {
    const content = contentOf(
      history(
        [
          { id: "c1", subject: "Add b", time: 1, set: { "b.ts": lines("x", "y") } },
          { id: "uncommitted", subject: "", time: null, set: { "a.ts": lines("1", "2", "3") } },
        ],
        { "a.ts": lines("1", "2") },
      ),
    )
    expect(content.layers.map((layer) => [layer.id, layer.kind])).toEqual([
      ["uncommitted", "uncommitted"],
      ["c1", "commit"],
    ])
    expect(content.layers[0]!.files).toMatchObject([
      { path: "a.ts", status: "modified", added: 1, removed: 0 },
    ])
    expect(content.layers[1]!.files).toMatchObject([{ path: "b.ts", status: "added", added: 2 }])
    expect(content.layers[1]).toMatchObject({ added: 2, removed: 0 })
  })

  it("tell a rename by the old path, and a deletion", () => {
    const content = contentOf(
      history(
        [{ id: "c1", subject: "", time: 1, move: { "new.ts": "old.ts" }, remove: ["gone.ts"] }],
        {
          "old.ts": lines("a"),
          "gone.ts": lines("b"),
        },
      ),
    )
    expect(content.layers[0]!.files).toMatchObject([
      { path: "gone.ts", status: "deleted", removed: 1 },
      { path: "new.ts", status: "renamed", oldPath: "old.ts", added: 0, removed: 0 },
    ])
  })

  it("count lines that only changed whitespace apart", () => {
    const content = contentOf(
      history(
        [
          {
            id: "c1",
            subject: "",
            time: 1,
            set: { "a.ts": lines("if (x) {", "    a()", "    b()", "}") },
          },
        ],
        {
          "a.ts": lines("if (x) {", "  a()", "  b()", "}"),
        },
      ),
    )
    expect(content.layers[0]!.files[0]).toMatchObject({ added: 0, removed: 0, reindented: 2 })
  })
})

describe("one file of a history", () => {
  const steps: History["steps"] = [
    {
      id: "c1",
      subject: "",
      time: 1,
      set: { "a.ts": lines("ONE", "2", "3", "4", "5", "6", "7", "8", "9", "10") },
    },
    { id: "c2", subject: "", time: 2, set: { "b.ts": lines("b") } },
    {
      id: "c3",
      subject: "",
      time: 3,
      set: { "a.ts": lines("ONE", "2", "3", "4", "5", "6", "7", "8", "9", "TEN") },
    },
  ]
  const start = { "a.ts": lines("1", "2", "3", "4", "5", "6", "7", "8", "9", "10") }

  it("is a hunk of the lines changed with three lines of context", () => {
    const [run] = diffOf(history(steps, start), "a.ts", ["c1"]).runs
    expect(run!.hunks).toEqual([
      {
        oldStart: 1,
        oldCount: 4,
        newStart: 1,
        newCount: 4,
        lines: [
          { kind: "remove", text: "1" },
          { kind: "add", text: "ONE" },
          { kind: "context", text: "2" },
          { kind: "context", text: "3" },
          { kind: "context", text: "4" },
        ],
      },
    ])
    expect(run).toMatchObject({ layers: ["c1"], before: start["a.ts"], big: false })
  })

  it("is one range for layers that follow one another, with both sides of the range", () => {
    const [run, ...rest] = diffOf(history(steps, start), "a.ts", ["c1", "c2", "c3"]).runs
    expect(rest).toEqual([])
    expect(run!.layers).toEqual(["c3", "c2", "c1"])
    expect(run!.hunks).toHaveLength(2)
    expect(run!.after).toBe(lines("ONE", "2", "3", "4", "5", "6", "7", "8", "9", "TEN"))
  })

  it("takes in the layers between the ends of the selection", () => {
    const runs = diffOf(history(steps, start), "a.ts", ["c1", "c3"]).runs
    expect(runs.map((run) => run.layers)).toEqual([["c3", "c2", "c1"]])
  })

  it("is no run for layers that did not change the file", () => {
    expect(diffOf(history(steps, start), "a.ts", ["c2"]).runs).toEqual([])
  })

  it("follows a file renamed within the range back to its old path", () => {
    const moved = history(
      [
        { id: "c1", subject: "", time: 1, move: { "new.ts": "old.ts" } },
        { id: "c2", subject: "", time: 2, set: { "new.ts": lines("a", "B") } },
      ],
      { "old.ts": lines("a", "b") },
    )
    const [run] = diffOf(moved, "new.ts", ["c1", "c2"]).runs
    expect(run).toMatchObject({
      file: { status: "renamed", oldPath: "old.ts", added: 1, removed: 1 },
      before: lines("a", "b"),
      after: lines("a", "B"),
    })
  })

  it("sends no lines for a file named big, binary or held", () => {
    const one = history([
      { id: "c1", subject: "", time: 1, set: { "a.ts": lines("x") }, held: ["a.ts"] },
    ])
    expect(diffOf(one, "a.ts", ["c1"]).runs[0]).toMatchObject({
      hunks: [],
      before: null,
      after: null,
    })
    const big: History = {
      ...history([{ id: "c1", subject: "", time: 1, set: { "a.ts": lines("x") } }]),
      big: ["a.ts"],
    }
    expect(diffOf(big, "a.ts", ["c1"]).runs[0]).toMatchObject({ big: true, hunks: [] })
  })
})

describe("the files of a range", () => {
  it("are the net of it: a file added and dropped inside is not there, one renamed is one row", () => {
    const range = rangeOf(
      history(
        [
          { id: "c1", subject: "", time: 1, set: { "t.txt": lines("t") } },
          { id: "c2", subject: "", time: 2, move: { "new.ts": "old.ts" }, remove: ["t.txt"] },
        ],
        { "old.ts": lines("a") },
      ),
      ["c1", "c2"],
    )
    expect(range).toMatchObject([{ path: "new.ts", status: "renamed", oldPath: "old.ts" }])
  })
})
