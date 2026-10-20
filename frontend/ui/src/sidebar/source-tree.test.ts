import type { SourceProject } from "@novadeck/core/source"

import { context, describe, expect, it } from "../test"
import {
  buildTree,
  chipsOf,
  chipsWidth,
  estimateNameWidth,
  fileIconOf,
  foldChips,
  initialOpen,
  litHandle,
  rowShowing,
  trailGone,
  trailLifeMs,
  trailOpacity,
  visibleRows,
  writtenPaths,
} from "./source-tree"

const project = (parts: Partial<SourceProject> = {}): SourceProject => ({
  entries: [],
  ignored: [],
  changes: {},
  writing: {},
  ...parts,
})

const paths = (rows: ReturnType<typeof visibleRows>): string[] => rows.map(({ node }) => node.path)

describe("The Source tree", () => {
  context("when entries and changed paths are joined", () => {
    it("lists folders before files, by name without case or a leading dot", () => {
      const tree = buildTree(
        project({
          entries: ["zeta.ts", "src/b.ts", "Alpha.ts", ".github/ci.yml", ".beta"],
          changes: { "src/a.ts": { kind: "added", touched: { moth: 1 } } },
        }),
      )

      expect(tree.map((node) => node.path)).toEqual([
        ".github",
        "src",
        "Alpha.ts",
        ".beta",
        "zeta.ts",
      ])
      expect(tree[1]!.children.map((node) => node.path)).toEqual(["src/a.ts", "src/b.ts"])
    })

    it("includes a file an agent added although it was never an entry", () => {
      const tree = buildTree(
        project({ changes: { "src/new.ts": { kind: "added", touched: { moth: 1 } } } }),
      )

      expect(tree[0]!.children[0]).toMatchObject({ path: "src/new.ts", kind: "added" })
    })

    it("treats an entry ending in a slash as a folder with nothing listed", () => {
      const tree = buildTree(project({ entries: ["node_modules/"] }))

      expect(tree).toMatchObject([{ path: "node_modules", folder: true, children: [] }])
    })

    it("marks ignored entries and everything inside them", () => {
      const tree = buildTree(project({ entries: ["dist/a.js", "src/a.ts"], ignored: ["dist/"] }))

      expect(tree.map((node) => [node.path, node.ignored])).toEqual([
        ["dist", true],
        ["src", false],
      ])
      expect(tree[0]!.children[0]!.ignored).toBe(true)
    })
  })

  context("when folders roll up their files", () => {
    const tree = buildTree(
      project({
        changes: {
          "src/a.ts": { kind: "modified", touched: { moth: 10, crow: 50 } },
          "src/deep/b.ts": { kind: "added", touched: { moth: 30 } },
        },
        writing: { moth: "src/deep/b.ts" },
      }),
    )

    it("keeps each agent's latest touch inside and who writes inside", () => {
      expect(tree[0]).toMatchObject({
        touched: { moth: 30, crow: 50 },
        writing: ["moth"],
        changed: true,
      })
    })
  })

  context("when choosing the folders that start open", () => {
    it("opens those with a changed file inside, leaving ignored and untouched ones shut", () => {
      const tree = buildTree(
        project({
          entries: ["docs/readme.md", "node_modules/x/y.js"],
          ignored: ["node_modules/"],
          changes: {
            "src/deep/b.ts": { kind: "modified", touched: { moth: 1 } },
            "node_modules/x/z.js": { kind: "added", touched: { moth: 1 } },
          },
        }),
      )

      expect([...initialOpen(tree)].toSorted()).toEqual(["src", "src/deep"])
    })
  })

  context("when listing the rows on screen", () => {
    const tree = buildTree(project({ entries: ["a/b/c.ts", "a/d.ts", "e.ts"] }))

    it("follows an open folder with its children and hides a closed one's", () => {
      expect(paths(visibleRows(tree, new Set(["a"])))).toEqual(["a", "a/b", "a/d.ts", "e.ts"])
      expect(paths(visibleRows(tree, new Set()))).toEqual(["a", "e.ts"])
    })

    it("gives each row its depth", () => {
      const rows = visibleRows(tree, new Set(["a", "a/b"]))

      expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1, 0])
    })
  })
})

describe("Which row shows a write", () => {
  it("is the file itself when every folder above it is open", () => {
    expect(rowShowing("a/b/c.ts", new Set(["a", "a/b"]))).toBe("a/b/c.ts")
  })

  it("is the outermost closed folder above a hidden file", () => {
    expect(rowShowing("a/b/c.ts", new Set())).toBe("a")
    expect(rowShowing("a/b/c.ts", new Set(["a"]))).toBe("a/b")
  })

  it("finds a write by a later time or a new file, and ignores the rest", () => {
    const before = { "a.ts": { kind: "modified", touched: { moth: 5 } } } as const
    const after = {
      "a.ts": { kind: "modified", touched: { moth: 9, crow: 1 } },
      "b.ts": { kind: "added", touched: { moth: 2 } },
    } as const

    expect(writtenPaths(before, before)).toEqual([])
    expect(writtenPaths(before, after)).toEqual(["a.ts", "b.ts"])
  })
})

describe("The chips on a row", () => {
  const touched = { moth: 10, crow: 30, wren: 20, kite: 5 }

  it("name the latest writers first, two at most, and fold the rest", () => {
    const chips = chipsOf(touched, [], undefined)

    expect(chips.shown).toEqual(["crow", "wren"])
    expect(chips.more).toBe(2)
    expect(chips.everyone).toEqual(["crow", "wren", "moth", "kite"])
  })

  it("put the selected terminal's agent first, then whoever is writing now", () => {
    expect(chipsOf(touched, ["moth"], undefined).shown).toEqual(["moth", "crow"])
    expect(chipsOf(touched, ["moth"], "kite").shown).toEqual(["kite", "moth"])
  })

  it("fold nothing for one or two agents", () => {
    expect(chipsOf({ moth: 1 }, [], undefined)).toMatchObject({ shown: ["moth"], more: 0 })
    expect(chipsOf({ moth: 1, crow: 2 }, [], undefined).more).toBe(0)
  })
})

describe("Folding a row's chips by its room", () => {
  const two = chipsOf({ moth: 2, crow: 1, wren: 0.5 }, [], undefined)
  const fit = { width: 228, depth: 0, nameWidth: 60, marks: 0 }

  it("keeps two chips when the name reads in full beside them", () => {
    expect(foldChips(two, fit)).toBe(two)
  })

  it("folds to one chip and counts everyone not shown when the name would be cut", () => {
    const folded = foldChips(two, { ...fit, nameWidth: 120 })

    expect(folded.shown).toEqual(["moth"])
    expect(folded.more).toBe(2)
    expect(folded.everyone).toEqual(two.everyone)
  })

  it("loses room to each level of depth and to a mark", () => {
    expect(foldChips(two, { ...fit, depth: 4 }).shown).toHaveLength(1)
    expect(foldChips(two, { ...fit, nameWidth: 78 }).shown).toHaveLength(2)
    expect(foldChips(two, { ...fit, nameWidth: 78, marks: 1 }).shown).toHaveLength(1)
  })

  it("never folds a row before its width is known, nor below one chip", () => {
    expect(foldChips(two, { ...fit, width: undefined, nameWidth: 999 })).toBe(two)
    expect(foldChips(two, { ...fit, width: 0, nameWidth: 999 }).shown).toHaveLength(1)
  })

  it("leaves a row of one agent alone", () => {
    const one = chipsOf({ moth: 1 }, [], undefined)

    expect(foldChips(one, { ...fit, width: 10, nameWidth: 999 })).toBe(one)
  })

  it("measures the chip area by handle length, with the count when there is one", () => {
    expect(chipsWidth(["moth"], 0)).toBeLessThan(chipsWidth(["moth", "crow"], 0))
    expect(chipsWidth(["moth", "crow"], 3)).toBeGreaterThan(chipsWidth(["moth", "crow"], 0))
    expect(estimateNameWidth("abcd")).toBe(estimateNameWidth("ab") * 2)
  })
})

describe("The lit agent", () => {
  const worked = project({
    changes: { "a.ts": { kind: "modified", touched: { moth: 1 } } },
    writing: { crow: "b.ts" },
  })

  it("is the selected terminal's agent when it has work here", () => {
    expect(litHandle(worked, "moth", undefined)).toBe("moth")
    expect(litHandle(worked, "crow", undefined)).toBe("crow")
  })

  it("is nobody for an agent with no work here, or no selected agent", () => {
    expect(litHandle(worked, "wren", undefined)).toBeUndefined()
    expect(litHandle(worked, undefined, undefined)).toBeUndefined()
    expect(litHandle(undefined, "moth", undefined)).toBeUndefined()
  })

  it("is the agent whose chip is pointed at, over the selected one", () => {
    expect(litHandle(worked, "moth", "crow")).toBe("crow")
  })
})

describe("A file's trail", () => {
  it("starts at 0.7 and fades by e every 150 seconds", () => {
    expect(trailOpacity(0)).toBeCloseTo(0.7)
    expect(trailOpacity(150_000)).toBeCloseTo(0.7 / Math.E)
  })

  it("is gone by the time its opacity falls below 0.04", () => {
    expect(trailOpacity(trailLifeMs)).toBeCloseTo(trailGone)
    expect(trailLifeMs / 1000).toBeGreaterThan(420)
    expect(trailLifeMs / 1000).toBeLessThan(440)
  })
})

describe("A plain file's icon", () => {
  it("follows its kind of file", () => {
    expect(
      [
        "a.ts",
        "b.tsx",
        "c.js",
        "d.html",
        "e.json",
        "f.md",
        "g.txt",
        ".gitignore",
        ".env.local",
        "h.png",
      ].map(fileIconOf),
    ).toEqual(["code", "code", "code", "code", "json", "text", "text", "text", "text", "file"])
  })
})
