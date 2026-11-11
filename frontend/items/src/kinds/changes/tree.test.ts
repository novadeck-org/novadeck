import type { ChangedFile, ChangeLayer } from "@novadeck/core/items"
import { describe, expect, it } from "vitest"

import { filesOf, rowsOf } from "./tree"

const file = (path: string, rest: Partial<ChangedFile> = {}): ChangedFile => ({
  path,
  oldPath: null,
  status: "modified",
  added: 1,
  removed: 0,
  reindented: 0,
  binary: false,
  secret: false,
  ...rest,
})
const layer = (id: string, files: ChangedFile[]): ChangeLayer => ({
  id,
  kind: id === "uncommitted" ? "uncommitted" : "commit",
  subject: "",
  time: null,
  added: 0,
  removed: 0,
  files,
  truncated: false,
})

const layers = [
  layer("uncommitted", [file("src/auth/cookies.ts", { added: 1, removed: 1 })]),
  layer("c2", [file("src/auth/session.ts", { added: 3 })]),
  layer("c1", [
    file("src/auth/session.ts", { status: "added", added: 17 }),
    file("README.md", { added: 2, reindented: 1 }),
  ]),
]

describe("the files the selected layers changed", () => {
  it("are every file of every layer when all are selected, with their lines added up", () => {
    const files = filesOf(layers, new Set(["uncommitted", "c2", "c1"]))
    expect(
      files.map(({ path, added, removed }) => `${path} +${added} -${removed}`).toSorted(),
    ).toEqual(["README.md +2 -0", "src/auth/cookies.ts +1 -1", "src/auth/session.ts +20 -0"])
  })

  it("are only those of the layers selected", () => {
    const files = filesOf(layers, new Set(["c2"]))
    expect(files.map(({ path, added, layers: by }) => [path, added, by])).toEqual([
      ["src/auth/session.ts", 3, ["c2"]],
    ])
  })

  it("tell a file added in the oldest layer selected as added, though later layers modified it", () => {
    const [session] = filesOf(layers, new Set(["c2", "c1"]))
    expect(session).toMatchObject({
      path: "src/auth/session.ts",
      status: "added",
      layers: ["c2", "c1"],
    })
    expect(filesOf(layers, new Set(["c2"]))[0]?.status).toBe("modified")
  })

  it("tell a file deleted by the newest layer as deleted", () => {
    const gone = [
      layer("c2", [file("a.ts", { status: "deleted", added: 0, removed: 4 })]),
      layer("c1", [file("a.ts")]),
    ]
    expect(filesOf(gone, new Set(["c2", "c1"]))[0]?.status).toBe("deleted")
  })

  it("keep that a file is binary or may hold secrets if any layer says so", () => {
    const held = [layer("c2", [file(".env")]), layer("c1", [file(".env", { secret: true })])]
    expect(filesOf(held, new Set(["c2", "c1"]))[0]?.secret).toBe(true)
  })

  it("count lines that only changed whitespace apart, added up as well", () => {
    expect(
      filesOf(layers, new Set(["c1"])).find((each) => each.path === "README.md")?.reindented,
    ).toBe(1)
  })
})

describe("the tree of files", () => {
  it("has a folder's folders before its files, each in name order, with a row for every folder", () => {
    const rows = rowsOf(filesOf(layers, new Set(["uncommitted", "c2", "c1"])))
    expect(
      rows.map((row) =>
        row.kind === "folder" ? `${row.depth} ${row.path}/` : `${row.depth} ${row.file.name}`,
      ),
    ).toEqual(["0 src/", "1 src/auth/", "2 cookies.ts", "2 session.ts", "0 README.md"])
  })

  it("splits a path into the folder it is in and its name", () => {
    const [one] = filesOf([layer("c1", [file("a/b/c.ts")])], new Set(["c1"]))
    expect(one).toMatchObject({ name: "c.ts", dir: "a/b" })
  })
})
