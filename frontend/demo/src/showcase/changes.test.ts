import type { ChangesContent } from "@novadeck/core/items"

import { describe, expect, it } from "../test"
import { changesArtifacts } from "./changes"

const contents = new Map(
  changesArtifacts.map(({ item, content }) => [
    item.id,
    content.state === "ready" && content.content.kind === "changes" ? content.content : undefined,
  ]),
)
const changeOf = (id: string): ChangesContent => contents.get(id)!

describe("the sample changes", () => {
  it("are items of the changes kind, each its own", () => {
    expect(changesArtifacts.every(({ item }) => item.kind === "changes")).toBe(true)
    expect(new Set(changesArtifacts.map(({ item }) => item.id)).size).toBe(changesArtifacts.length)
    expect(new Set(changesArtifacts.map(({ item }) => item.path)).size).toBe(
      changesArtifacts.length,
    )
  })

  it("count the lines they add and remove as their hunks hold them, where they hold any", () => {
    for (const content of contents.values())
      for (const file of content!.files.filter((each) => each.hunks.length > 0)) {
        const lines = file.hunks.flatMap((hunk) => hunk.lines)
        expect(file.added, file.path).toBe(lines.filter((line) => line.kind === "add").length)
        expect(file.removed, file.path).toBe(lines.filter((line) => line.kind === "remove").length)
      }
  })

  it("have hunk headers that count the lines the hunk holds", () => {
    for (const content of contents.values())
      for (const file of content!.files)
        for (const hunk of file.hunks) {
          expect(hunk.oldCount, file.path).toBe(
            hunk.lines.filter((line) => line.kind !== "add").length,
          )
          expect(hunk.newCount, file.path).toBe(
            hunk.lines.filter((line) => line.kind !== "remove").length,
          )
        }
  })

  it("show an ordinary change, files moved, deleted and added, a binary file, a held one, a truncated change and none", () => {
    expect(changeOf("change").files.map((file) => file.status)).toEqual([
      "modified",
      "modified",
      "added",
    ])
    const moves = changeOf("change-moves").files
    expect(moves.map((file) => file.status)).toEqual(["renamed", "deleted", "renamed", "added"])
    expect(moves[2]!.hunks).toEqual([])
    expect(moves[0]!.oldPath).toBe("src/pages/Projects.tsx")
    expect(changeOf("change-binary").files.some((file) => file.binary)).toBe(true)
    expect(changeOf("change-held").files.some((file) => file.secret)).toBe(true)
    const truncated = changeOf("change-truncated")
    expect(truncated.truncated).toBe(true)
    expect(truncated.files.some((file) => file.listed)).toBe(true)
    expect(changeOf("change-none").files).toEqual([])
    const long = changeOf("change-long").files[0]!.hunks[0]!.lines
    expect(Math.max(...long.map((line) => line.text.length))).toBeGreaterThan(200)
  })
})
