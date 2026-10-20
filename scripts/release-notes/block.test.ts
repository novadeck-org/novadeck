import { describe, expect, it } from "vitest"

import {
  notesBlock,
  readNotesBlock,
  type ReleaseNotes,
} from "../../contract/protocol/src/release-notes.ts"
import { releaseBody } from "./fixtures.ts"

const notes: ReleaseNotes = {
  version: "0.0.152",
  kind: "promote",
  highlights: [
    {
      title: "Word handles",
      line: "Terminals get a name like @moth instead of t11.",
      prs: [181],
    },
  ],
  changes: [
    { area: "Inbox & notifications", line: "Answer agents from the Inbox.", prs: [195] },
    { area: "Fixes & speedups", line: "Off-screen Canvas nodes stop laying out.", prs: [261] },
  ],
  fixes: 4,
}

describe("the notes block", () => {
  it("is one compact HTML comment that reads back to the notes", () => {
    const block = notesBlock(notes)
    expect(block).toMatch(/^<!-- novadeck:notes \{.*\} -->$/)
    expect(block).not.toContain("\n")
    expect(readNotesBlock(`## Title\n\nText\n\n${block}\n\n<details></details>`)).toEqual(notes)
  })

  it("is compact JSON with the literal kind, which release.yml's jq guard matches", () => {
    expect(notesBlock(notes)).toContain('"kind":"promote"')
    expect(notesBlock({ ...notes, kind: "release" })).toContain('"kind":"release"')
  })

  it("can't be closed early by the text it holds", () => {
    const sneaky = {
      ...notes,
      changes: [{ area: "Voice" as const, line: "a --> b -- c <!-- d", prs: [1] }],
    }
    const block = notesBlock(sneaky)
    expect(block.slice("<!-- ".length, -" -->".length)).not.toContain("--")
    expect(readNotesBlock(block)).toEqual(sneaky)
  })

  it("reads a block a later pipeline extended: unknown keys are ignored, unknown areas dropped", () => {
    const later = JSON.stringify({
      ...notes,
      extra: 1,
      highlights: [{ ...notes.highlights[0], icon: "star" }],
      changes: [...notes.changes, { area: "Sharing", line: "A new area.", prs: [9] }],
    })
    expect(readNotesBlock(`<!-- novadeck:notes ${later} -->`)).toEqual(notes)
  })

  it("clamps what would break the writer, so what it returns is always writable", () => {
    const wild = {
      ...notes,
      highlights: Array.from({ length: 6 }, (_, index) => ({
        title: `T${index}`,
        line: "L",
        prs: [1],
      })),
      changes: [
        { area: "Voice", line: "x".repeat(241), prs: [1] },
        { area: "Voice", line: "Bad numbers.", prs: [1.5] },
        { area: "Voice", line: "Negative.", prs: [-3] },
        { area: "Voice", line: "Kept.", prs: [2] },
        ...Array.from({ length: 250 }, () => ({ area: "Voice", line: "More.", prs: [3] })),
      ],
      fixes: -1,
    }
    const read = readNotesBlock(`<!-- novadeck:notes ${JSON.stringify(wild)} -->`)!
    expect(read.highlights).toHaveLength(4)
    expect(read.changes).toHaveLength(200)
    expect(read.changes[0]?.line).toBe("Kept.")
    expect(read.fixes).toBe(0)
    expect(readNotesBlock(notesBlock(read))).toEqual(read)
    const title = { ...notes, highlights: [{ title: "t".repeat(81), line: "L", prs: [1] }] }
    expect(readNotesBlock(`<!-- novadeck:notes ${JSON.stringify(title)} -->`)?.highlights).toEqual(
      [],
    )
  })

  it("is not there when the kind is one it doesn't know", () => {
    expect(readNotesBlock(notesBlock(notes).replace('"promote"', '"nightly"'))).toBeUndefined()
  })

  it("is not in a release body that has none, nor in an empty one", () => {
    expect(readNotesBlock(releaseBody)).toBeUndefined()
    expect(readNotesBlock("")).toBeUndefined()
  })

  it("is not there when a hand edit broke it", () => {
    const block = notesBlock(notes)
    const broken = [
      block.replace(/\}/, ""),
      block.replace('"kind":"promote"', '"kind":"nonsense"'),
      block.replace("{", "{{"),
      block.replace(" -->", ""),
      block.replace("novadeck:notes", "novadeck:note"),
      "<!-- novadeck:notes [] -->",
      "<!-- novadeck:notes null -->",
    ]
    for (const body of broken) expect(readNotesBlock(`text\n${body}\n`), body).toBeUndefined()
  })

  it("refuses to write notes of the wrong shape", () => {
    expect(() => notesBlock({ ...notes, highlights: Array(5).fill(notes.highlights[0]) })).toThrow(
      /too_big|Too big|highlights/i,
    )
  })
})
