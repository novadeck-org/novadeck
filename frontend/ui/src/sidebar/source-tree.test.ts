import type { SourceProject } from "@novadeck/core/source"

import { context, describe, expect, it } from "../test"
import { folderListings } from "../test/source"
import {
  buildTree,
  expandable,
  keepListings,
  sameRead,
  visibleLines,
  chipsOf,
  chipsWidth,
  marksOf,
  estimateNameWidth,
  fileIconOf,
  foldChips,
  initialOpen,
  rowShowing,
  trailGone,
  trailLifeMs,
  trailOpacity,
  visibleRows,
  writtenPaths,
} from "./source-tree"

const project = (parts: Partial<SourceProject> = {}): SourceProject => ({
  changes: {},
  writing: {},
  ...parts,
})

const paths = (rows: ReturnType<typeof visibleRows>): string[] => rows.map(({ node }) => node.path)

describe("The Source tree", () => {
  context("when listings and changed paths are joined", () => {
    it("lists folders before files, by name without case or a leading dot", () => {
      const tree = buildTree(
        folderListings(["zeta.ts", "src/b.ts", "Alpha.ts", ".github/ci.yml", ".beta"]),
        project({ changes: { "src/a.ts": { kind: "added", touched: { moth: 1 } } } }),
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

    it("includes a file an agent added although no listing has it", () => {
      const tree = buildTree(
        new Map(),
        project({ changes: { "src/new.ts": { kind: "added", touched: { moth: 1 } } } }),
      )

      expect(tree[0]!.children[0]).toMatchObject({ path: "src/new.ts", kind: "added" })
    })

    it("shows a file listed and changed once", () => {
      const tree = buildTree(
        folderListings(["src/a.ts"]),
        project({ changes: { "src/a.ts": { kind: "modified", touched: { moth: 1 } } } }),
      )

      expect(tree[0]!.children).toMatchObject([{ path: "src/a.ts", kind: "modified" }])
    })

    it("marks ignored entries and everything inside them", () => {
      const tree = buildTree(folderListings(["dist/a.js", "src/a.ts"], ["dist"]))

      expect(tree.map((node) => [node.path, node.ignored])).toEqual([
        ["dist", true],
        ["src", false],
      ])
      expect(tree[0]!.children[0]!.ignored).toBe(true)
    })

    it("builds from the listings alone where there are no changes", () => {
      expect(buildTree(folderListings(["a.ts"]))).toMatchObject([{ path: "a.ts", changed: false }])
    })
  })

  context("when a folder has been read, or not", () => {
    const root = {
      entries: [{ name: "src", folder: true, ignored: false }],
      truncated: false,
    }
    const treeOf = (
      src?: Parameters<typeof buildTree>[0] extends ReadonlyMap<string, infer V> ? V : never,
    ) =>
      buildTree(
        new Map(
          src
            ? [
                ["", root],
                ["src", src],
              ]
            : [["", root]],
        ),
      )

    it("counts a folder not read yet as one to open", () => {
      const [src] = treeOf()
      expect(src).toMatchObject({ read: "unread", children: [] })
      expect(expandable(src!)).toBe(true)
    })

    it("counts a folder read and empty as nothing to open", () => {
      const [src] = treeOf({ entries: [], truncated: false })
      expect(src).toMatchObject({ read: "read" })
      expect(expandable(src!)).toBe(false)
    })

    it("counts a folder that could not be read as one to open, for its note", () => {
      const [src] = treeOf("failed")
      expect(src).toMatchObject({ read: "failed" })
      expect(expandable(src!)).toBe(true)
    })

    it("counts a folder that lists part of its entries as one to open, though it lists none", () => {
      const [src] = treeOf({ entries: [], truncated: true })
      expect(src).toMatchObject({ truncated: true })
      expect(expandable(src!)).toBe(true)
    })

    it("ends an open folder with a note of what it lacks", () => {
      const open = new Set(["src"])
      const note = (tree: ReturnType<typeof treeOf>) =>
        visibleLines(tree, open).filter((line) => "note" in line)
      expect(note(treeOf("failed"))).toEqual([{ note: "failed", path: "src", depth: 1 }])
      expect(note(treeOf({ entries: [], truncated: true }))).toEqual([
        { note: "truncated", path: "src", depth: 1 },
      ])
      expect(note(treeOf({ entries: [], truncated: false }))).toEqual([])
    })
  })

  context("when keeping the listings of the folders still there", () => {
    const listing = (names: string[]) => ({
      entries: names.map((name) => ({ name, folder: true, ignored: false })),
      truncated: false,
    })

    it("drops those of a folder that vanished", () => {
      const listings = new Map([
        ["", listing(["a"])],
        ["a", listing([])],
        ["gone", listing([])],
      ])

      expect([...keepListings(listings, buildTree(listings)).keys()]).toEqual(["", "a"])
    })

    it("returns the same listings where nothing vanished", () => {
      const listings = new Map([["", listing(["a"])]])

      expect(keepListings(listings, buildTree(listings))).toBe(listings)
    })
  })

  context("when comparing two readings of a folder", () => {
    const entry = { name: "a", folder: false, ignored: false }

    it("finds the same entries the same, and any difference not", () => {
      expect(
        sameRead(
          { entries: [entry], truncated: false },
          { entries: [{ ...entry }], truncated: false },
        ),
      ).toBe(true)
      expect(
        sameRead({ entries: [entry], truncated: false }, { entries: [entry], truncated: true }),
      ).toBe(false)
      expect(
        sameRead(
          { entries: [entry], truncated: false },
          { entries: [{ ...entry, ignored: true }], truncated: false },
        ),
      ).toBe(false)
      expect(sameRead("failed", "failed")).toBe(true)
      expect(sameRead("failed", { entries: [], truncated: false })).toBe(false)
    })
  })

  context("when folders roll up their files", () => {
    const tree = buildTree(
      new Map(),
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
        folderListings(["docs/readme.md", "node_modules/x/y.js"], ["node_modules"]),
        project({
          changes: {
            "src/deep/b.ts": { kind: "modified", touched: { moth: 1 } },
            "node_modules/x/z.js": { kind: "added", touched: { moth: 1 } },
          },
        }),
      )

      expect([...initialOpen(tree)].toSorted()).toEqual(["src", "src/deep"])
    })

    it("opens nothing where there are no changes", () => {
      expect(initialOpen(buildTree(folderListings(["a/b.ts"])))).toEqual(new Set())
    })
  })

  context("when listing the rows on screen", () => {
    const tree = buildTree(folderListings(["a/b/c.ts", "a/d.ts", "e.ts"]))

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

const none: ReadonlySet<string> = new Set()

describe("The chips on a row", () => {
  const touched = { moth: 10, crow: 30, wren: 20, kite: 5 }

  it("name the latest writers first, two at most, and fold the rest", () => {
    const chips = chipsOf(touched, [], none)

    expect(chips.shown).toEqual(["crow", "wren"])
    expect(chips.more).toBe(2)
    expect(chips.everyone).toEqual(["crow", "wren", "moth", "kite"])
  })

  it("put the lit agents first, then whoever is writing now", () => {
    expect(chipsOf(touched, ["moth"], none).shown).toEqual(["moth", "crow"])
    expect(chipsOf(touched, ["moth"], new Set(["kite"])).shown).toEqual(["kite", "moth"])
    expect(chipsOf(touched, [], new Set(["kite", "moth"])).shown).toEqual(["moth", "kite"])
  })

  it("fold nothing for one or two agents", () => {
    expect(chipsOf({ moth: 1 }, [], none)).toMatchObject({ shown: ["moth"], more: 0 })
    expect(chipsOf({ moth: 1, crow: 2 }, [], none).more).toBe(0)
  })
})

describe("Folding a row's chips by its room", () => {
  const two = chipsOf({ moth: 2, crow: 1, wren: 0.5 }, [], none)
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
    const one = chipsOf({ moth: 1 }, [], none)

    expect(foldChips(one, { ...fit, width: 10, nameWidth: 999 })).toBe(one)
  })

  it("measures the chip area by handle length, with the count when there is one", () => {
    expect(chipsWidth(["moth"], 0)).toBeLessThan(chipsWidth(["moth", "crow"], 0))
    expect(chipsWidth(["moth", "crow"], 3)).toBeGreaterThan(chipsWidth(["moth", "crow"], 0))
    expect(estimateNameWidth("abcd")).toBe(estimateNameWidth("ab") * 2)
  })

  it("measures each chip text it is given, `@handle` and `+N`", () => {
    const seen: string[] = []
    const width = chipsWidth(["moth", "crow"], 3, (text) => {
      seen.push(text)
      return 40
    })

    expect(seen).toEqual(["@moth", "@crow", "+3"])
    expect(width).toBe(8 + 3 * 40 + 2 * 6)
  })

  it("folds by the measured chips, not the estimate", () => {
    const wide = { ...fit, nameWidth: 78, chipWidth: () => 60 }

    expect(foldChips(two, wide).shown).toHaveLength(1)
    expect(foldChips(two, { ...wide, chipWidth: () => 20 }).shown).toHaveLength(2)
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

describe("The marks after a file's name", () => {
  const file = (touched: Record<string, number>, writing: string[] = []) =>
    buildTree(
      new Map(),
      project({
        changes: { "a.ts": { kind: "modified", touched } },
        writing: Object.fromEntries(writing.map((handle) => [handle, "a.ts"])),
      }),
    )[0]!

  it("are a cursor for each agent writing, else one slot for the trail whatever its age", () => {
    expect(marksOf(file({ moth: 1, crow: 2 }, ["moth", "crow"]))).toBe(2)
    expect(marksOf(file({ moth: 1 }))).toBe(1)
    expect(marksOf(file({ moth: Date.now() - 24 * 3_600_000 }))).toBe(1)
  })

  it("are none for a file nobody changed, or a folder", () => {
    expect(marksOf(buildTree(folderListings(["a.ts", "src/"]))[0]!)).toBe(0)
    expect(
      marksOf(
        buildTree(
          new Map(),
          project({ changes: { "src/a.ts": { kind: "added", touched: { moth: 1 } } } }),
        )[0]!,
      ),
    ).toBe(0)
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
