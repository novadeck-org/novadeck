import type { ChangesContent } from "@novadeck/core/items"

import { describe, expect, it } from "../test"
import { changesArtifacts, contentOfSample, workChanges } from "./changes"

const samples = new Map(changesArtifacts.map((artifact) => [artifact.item.id, artifact]))
const changeOf = (id: string): ChangesContent => contentOfSample(samples.get(id)!)!
const readFile = (id: string, path: string, layers: readonly string[]) =>
  samples.get(id)!.changeFile!(path, layers)

describe("the sample changes", () => {
  it("are items of the changes kind, each its own", () => {
    expect(changesArtifacts.every(({ item }) => item.kind === "changes")).toBe(true)
    expect(new Set(changesArtifacts.map(({ item }) => item.id)).size).toBe(changesArtifacts.length)
    expect(new Set(changesArtifacts.map(({ item }) => item.path)).size).toBe(
      changesArtifacts.length,
    )
  })

  it("each read a file's diff, whose lines add up to what its layer lists", () => {
    for (const artifact of changesArtifacts) {
      const content = contentOfSample(artifact)!
      for (const layer of content.layers)
        for (const file of layer.files.filter((each) => !each.binary && !each.secret)) {
          const { run } = artifact.changeFile!(file.path, [layer.id])
          if (!run || run.big) continue
          const lines = run.hunks.flatMap((hunk) => hunk.lines)
          const reindented = file.reindented
          // Lines that only changed whitespace are in the diff, but not in the counts.
          expect(lines.filter((line) => line.kind === "add").length - reindented, file.path).toBe(
            file.added,
          )
          expect(
            lines.filter((line) => line.kind === "remove").length - reindented,
            file.path,
          ).toBe(file.removed)
        }
    }
  })

  it("have hunk headers that count the lines the hunk holds", () => {
    for (const artifact of changesArtifacts)
      for (const layer of contentOfSample(artifact)!.layers)
        for (const file of layer.files)
          for (const run of [artifact.changeFile!(file.path, [layer.id]).run ?? undefined].filter(
            (each) => each !== undefined,
          ))
            for (const hunk of run.hunks) {
              expect(hunk.oldCount, file.path).toBe(
                hunk.lines.filter((line) => line.kind !== "add").length,
              )
              expect(hunk.newCount, file.path).toBe(
                hunk.lines.filter((line) => line.kind !== "remove").length,
              )
            }
  })

  it("show an ordinary change in layers: the uncommitted work above the commits since main", () => {
    const change = changeOf("change")
    expect(change.base).toBe("main")
    expect(change.layers.map((layer) => [layer.kind, layer.subject])).toEqual([
      ["uncommitted", ""],
      ["commit", "Test verifySession across routes"],
      ["commit", "Check session expiry in one place"],
    ])
    expect(change.layers[1]!.id.slice(0, 7)).toBe("7d02b4a")
    expect(change.layers[0]!.files.map((file) => file.path)).toEqual([
      "README.md",
      "src/auth/cookies.ts",
      "src/auth/session.test.ts",
    ])
    // The header's nav was re-indented.
    expect(
      change.layers[2]!.files.find((file) => file.path === "src/components/Header.tsx"),
    ).toMatchObject({ added: 4, removed: 6, reindented: 4 })
  })

  it("read a file for the layers selected as one range, taking in those between its ends", () => {
    const [newest, middle, oldest] = changeOf("change").layers.map((layer) => layer.id)
    const joined = readFile("change", "src/auth/session.test.ts", [newest!, middle!])
    expect(joined.run).toMatchObject({
      layers: [newest, middle],
      file: { status: "added" },
      before: null,
    })
    const wide = readFile("change", "src/auth/cookies.ts", [newest!, oldest!])
    expect(wide.run?.layers).toEqual([newest, middle, oldest])
    expect(readFile("change", "src/auth/cookies.ts", [middle!]).run).toBeNull()
  })

  it("show files moved, deleted and added, a binary file, a held one, a truncated change and none", () => {
    const moves = changeOf("change-moves").layers[0]!.files
    expect(moves.map((file) => [file.path, file.status])).toEqual([
      ["README.md", "added"],
      ["src/legacy.js", "deleted"],
      ["src/pages/Studio.tsx", "renamed"],
      ["src/pages/Work.tsx", "renamed"],
    ])
    expect(moves.find((file) => file.path === "src/pages/Work.tsx")?.oldPath).toBe(
      "src/pages/Projects.tsx",
    )
    expect(changeOf("change-binary").layers[0]!.files.some((file) => file.binary)).toBe(true)
    expect(changeOf("change-held").layers[0]!.files.some((file) => file.secret)).toBe(true)
    expect(changeOf("change-truncated").truncated).toBe(true)
    expect(changeOf("change-old-git").layers.map((layer) => layer.firstParent)).toEqual([
      true,
      undefined,
    ])
    expect(
      readFile("change-truncated", "src/generated/part-1.json", ["uncommitted"]).run,
    ).toMatchObject({
      big: true,
      hunks: [],
    })
    expect(changeOf("change-none").layers.flatMap((layer) => layer.files)).toEqual([])
  })

  it("never read a binary file or one that may hold secrets", () => {
    for (const [id, path] of [
      ["change-binary", "public/logo.png"],
      ["change-held", ".env.local"],
    ] as const) {
      const { run } = readFile(id, path, ["uncommitted"])
      expect(run).toMatchObject({ hunks: [], before: null, after: null })
    }
    expect(JSON.stringify(readFile("change-held", ".env.local", ["uncommitted"]))).not.toContain(
      "API_KEY",
    )
  })

  it("keep a line a long change holds whole", () => {
    const { run } = readFile("change-long", "src/content/credits.json", ["uncommitted"])
    const lines = run!.hunks.flatMap((hunk) => hunk.lines)
    expect(Math.max(...lines.map((line) => line.text.length))).toBeGreaterThan(200)
  })
})

describe("a work as a change", () => {
  const work = {
    terminalId: "t",
    projectId: "p",
    root: "/w/shop",
    branch: "feature",
    base: "main",
    firstSeenAt: 0,
    merged: false,
    added: 7,
    removed: 3,
    unreadAdded: 0,
    unreadRemoved: 0,
    files: [
      { path: "src/a.ts", added: 5, removed: 2 },
      { path: "src/b.ts", added: 2, removed: 1 },
    ],
    truncated: false,
    conflicts: [],
  } as never

  it("lists the work's files with the work's own counts, in a layer of uncommitted work", () => {
    const made = workChanges(work, "Checkout")
    const content = contentOfSample(made)!
    expect(content).toMatchObject({ root: "/w/shop", base: "main" })
    expect(content.layers).toHaveLength(1)
    expect(content.layers[0]!.files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["src/a.ts", 5, 2],
      ["src/b.ts", 2, 1],
    ])
    expect(made.item.detail).toBe("Checkout against main · 2 files")
    expect(made.changeFile!("src/a.ts", ["uncommitted"]).run!.hunks).not.toEqual([])
  })
})
