import type { FolderEntry } from "@novadeck/core/items"

import { context, describe, expect, it } from "../../test"
import {
  absoluteOf,
  arrive,
  crumbsOf,
  durationText,
  grown,
  intoFolder,
  nextSort,
  noArrivals,
  parentOf,
  sizeShort,
  sorted,
} from "./model"

const entry = (name: string, extra: Partial<FolderEntry> = {}): FolderEntry => ({
  name,
  kind: "image",
  size: 1,
  modifiedAt: 1,
  children: null,
  secret: false,
  link: false,
  stamp: "s",
  ...extra,
})

describe("a folder's listing", () => {
  context("sorted", () => {
    const entries = [
      entry("b.png", { modifiedAt: 5, size: 10 }),
      entry("a.png", { modifiedAt: 9, size: 30 }),
      entry("old", { kind: "folder", modifiedAt: 1, size: 0, children: 2 }),
      entry("c10.png", { modifiedAt: 5, size: 20 }),
      entry("c2.png", { modifiedAt: 5, size: 20 }),
    ]
    const names = (sort: Parameters<typeof sorted>[1]) =>
      sorted(entries, sort).map(({ name }) => name)

    it("puts the newest first, whatever it is, so what was just written is on top", () => {
      expect(names("newest")).toEqual(["a.png", "b.png", "c2.png", "c10.png", "old"])
    })

    it("puts folders first by name, numbers as numbers", () => {
      expect(names("name")).toEqual(["old", "a.png", "b.png", "c2.png", "c10.png"])
    })

    it("puts folders first by size, then the largest", () => {
      expect(names("size")).toEqual(["old", "a.png", "c2.png", "c10.png", "b.png"])
    })

    it("leaves the listing as it was", () => {
      const before = entries.map(({ name }) => name)
      sorted(entries, "name")
      expect(entries.map(({ name }) => name)).toEqual(before)
    })

    it("cycles through the sorts", () => {
      expect(nextSort("newest")).toBe("name")
      expect(nextSort("name")).toBe("size")
      expect(nextSort("size")).toBe("newest")
    })
  })

  context("where it is", () => {
    it("starts its crumbs at the folder that was opened, the path above it only text", () => {
      expect(crumbsOf("/home/me/render", "")).toEqual({
        above: "/home/me/",
        crumbs: [{ name: "render", within: "" }],
      })
      expect(crumbsOf("/home/me/render/", "old-runs/notes")).toEqual({
        above: "/home/me/",
        crumbs: [
          { name: "render", within: "" },
          { name: "old-runs", within: "old-runs" },
          { name: "notes", within: "old-runs/notes" },
        ],
      })
      expect(crumbsOf("C:\\work\\render", "")).toMatchObject({ above: "C:\\work\\" })
      expect(crumbsOf("/", "")).toEqual({ above: "", crumbs: [{ name: "/", within: "" }] })
    })

    it("goes into a folder and back out of it, never above the top", () => {
      expect(intoFolder("", "old-runs")).toBe("old-runs")
      expect(intoFolder("old-runs", "notes")).toBe("old-runs/notes")
      expect(parentOf("old-runs/notes")).toBe("old-runs")
      expect(parentOf("old-runs")).toBe("")
      expect(parentOf("")).toBeNull()
    })

    it("names a file by its absolute path, in the separator the folder is written in", () => {
      expect(absoluteOf("/tmp/render", "a.png")).toBe("/tmp/render/a.png")
      expect(absoluteOf("/", "a.png")).toBe("/a.png")
      expect(absoluteOf("C:\\work\\render", "a.png")).toBe("C:\\work\\render\\a.png")
    })
  })

  context("what lands while the pointer is in the grid", () => {
    it("draws the first listing whole", () => {
      const state = arrive(noArrivals, ["a", "b"], true)
      expect([...state.seen!]).toEqual(["a", "b"])
      expect(state.held.size).toBe(0)
      expect(state.fresh.size).toBe(0)
    })

    it("keeps new files waiting while the pointer is in, and lets them in once it is out", () => {
      const first = arrive(noArrivals, ["a"], false)
      const waiting = arrive(first, ["a", "b", "c"], true)
      expect([...waiting.held]).toEqual(["b", "c"])
      expect([...waiting.seen!]).toEqual(["a"])
      expect(arrive(waiting, ["a", "b", "c"], true)).toBe(waiting)
      const released = arrive(waiting, ["a", "b", "c"], false)
      expect(released.held.size).toBe(0)
      expect([...released.fresh]).toEqual(["b", "c"])
    })

    it("draws new files at once where the pointer is out, marking them new", () => {
      const first = arrive(noArrivals, ["a"], false)
      const next = arrive(first, ["a", "b"], false)
      expect([...next.seen!]).toEqual(["a", "b"])
      expect([...next.fresh]).toEqual(["b"])
    })

    it("forgets what left, held or drawn", () => {
      const waiting = arrive(arrive(noArrivals, ["a", "b"], false), ["a", "b", "c"], true)
      const after = arrive(waiting, ["a"], true)
      expect([...after.held]).toEqual([])
      expect([...after.seen!]).toEqual(["a"])
    })
  })

  context("what is being written", () => {
    it("is the files whose size changed between two listings", () => {
      const before = [
        entry("a", { size: 1 }),
        entry("b", { size: 5 }),
        entry("old", { kind: "folder", size: 0 }),
      ]
      const after = [
        entry("a", { size: 4 }),
        entry("b", { size: 5, modifiedAt: 9 }),
        entry("c", { size: 3 }),
        entry("old", { kind: "folder", size: 9 }),
      ]
      expect(grown(before, after)).toEqual(["a"])
    })
  })

  it("writes a size short", () => {
    expect([0, 77, 2048, 1.5 * 1024 * 1024].map(sizeShort)).toEqual([
      "0 B",
      "77 B",
      "2 KB",
      "1.5 MB",
    ])
  })

  it("writes a duration as a player does", () => {
    expect(durationText(7.4)).toBe("0:07")
    expect(durationText(65)).toBe("1:05")
    expect(durationText(3723)).toBe("1:02:03")
  })
})
