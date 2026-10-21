import type { ChangesContent } from "@novadeck/core/companion"

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

  it("show an ordinary change, files moved, deleted and added, a binary file, a held one, a truncated change and none", () => {
    expect(changeOf("change").files.map((file) => file.status)).toEqual([
      "modified",
      "modified",
      "added",
    ])
    const moves = changeOf("change-moves").files
    expect(moves.map((file) => file.status)).toEqual(["renamed", "deleted", "added"])
    expect(moves[0]!.oldPath).toBe("src/pages/Projects.tsx")
    expect(changeOf("change-binary").files.some((file) => file.binary)).toBe(true)
    expect(changeOf("change-held").files.some((file) => file.held)).toBe(true)
    const truncated = changeOf("change-truncated")
    expect(truncated.truncated).toBe(true)
    expect(truncated.files.some((file) => file.listed)).toBe(true)
    expect(changeOf("change-none").files).toEqual([])
  })
})
