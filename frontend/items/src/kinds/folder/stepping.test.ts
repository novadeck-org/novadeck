import type { FolderEntry, Item } from "@novadeck/core/items"
import { itemFixture } from "@novadeck/core/testing"

import { context, describe, expect, it } from "../../test"
import { fileNameOf, homeOf, neighboursOf, stepsOf } from "./stepping"

const folder = (id: string, path: string, terminalId = "1", extra: Partial<Item> = {}): Item =>
  itemFixture(id, terminalId, { kind: "folder", name: id, path, ...extra })

const file = (path: string, terminalId = "1", extra: Partial<Item> = {}): Item =>
  itemFixture("file", terminalId, { kind: "image", name: "file.png", path, ...extra })

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

describe("the folder a file is in", () => {
  context("which folder item holds it", () => {
    it("is the one whose top is a folder above the file, and says where in it the file sits", () => {
      const render = folder("render", "/tmp/render")
      expect(homeOf(file("/tmp/render/a.png"), [render])).toEqual({ folder: render, within: "" })
      expect(homeOf(file("/tmp/render/old/runs/a.png"), [render])).toEqual({
        folder: render,
        within: "old/runs",
      })
    })

    it("is none where no folder item is above the file, or the file is beside a top only by name", () => {
      expect(homeOf(file("/tmp/other/a.png"), [folder("render", "/tmp/render")])).toBeUndefined()
      expect(homeOf(file("/tmp/render-2/a.png"), [folder("render", "/tmp/render")])).toBeUndefined()
      expect(homeOf(file("/tmp/render/a.png"), [])).toBeUndefined()
    })

    it("is none for a file that is no file's item, or points nowhere", () => {
      const render = folder("render", "/tmp/render")
      expect(homeOf(file("/tmp/render/a.png", "1", { kind: "page" }), [render])).toBeUndefined()
      expect(homeOf(file("/tmp/render/a.png", "1", { path: null }), [render])).toBeUndefined()
    })

    it("is none for a file at the top's own path", () => {
      const render = folder("render", "/tmp/render")
      expect(homeOf(file("/tmp/render", "1", { kind: "file" }), [render])).toBeUndefined()
    })

    it("takes the deepest top among folders above the file", () => {
      const top = folder("top", "/tmp/render")
      const inner = folder("inner", "/tmp/render/old")
      expect(homeOf(file("/tmp/render/old/a.png"), [top, inner])).toEqual({
        folder: inner,
        within: "",
      })
      expect(homeOf(file("/tmp/render/old/a.png"), [inner, top])?.folder).toBe(inner)
    })

    it("prefers a folder on the file's own holder over a deeper one elsewhere", () => {
      const mine = folder("mine", "/tmp/render", "1")
      const deeper = folder("deeper", "/tmp/render/old", "2")
      expect(homeOf(file("/tmp/render/old/a.png", "1"), [deeper, mine])?.folder).toBe(mine)
      expect(homeOf(file("/tmp/render/old/a.png", "3"), [mine, deeper])?.folder).toBe(deeper)
    })

    it("takes a holder that is a window as a holder too", () => {
      const windowed = folder("windowed", "/tmp/render", "1", { holder: { windowId: "w" } })
      const bar = folder("bar", "/tmp/render/old", "1")
      const inWindow = file("/tmp/render/old/a.png", "1", { holder: { windowId: "w" } })
      expect(homeOf(inWindow, [bar, windowed])?.folder).toBe(windowed)
    })

    it("reads Windows paths by their backslashes, a drive's too", () => {
      const render = folder("render", "C:\\Users\\me\\render")
      expect(homeOf(file("C:\\Users\\me\\render\\old\\a.png"), [render])).toEqual({
        folder: render,
        within: "old",
      })
      expect(homeOf(file("C:\\Users\\me\\render\\a.png"), [render])?.within).toBe("")
      expect(homeOf(file("C:\\Users\\me\\render-2\\a.png"), [render])).toBeUndefined()
      expect(homeOf(file("D:\\Users\\me\\render\\a.png"), [render])).toBeUndefined()
      expect(
        homeOf(file("C:\\Users\\me\\render\\a.png"), [folder("t", "C:\\Users\\me\\render\\")]),
      ).toMatchObject({ within: "" })
    })
  })

  context("which files stepping goes through", () => {
    const entries = [
      entry("b.png", { modifiedAt: 5, size: 10 }),
      entry("a.png", { modifiedAt: 9, size: 30 }),
      entry("c.png", { modifiedAt: 7, size: 20 }),
      entry("clip.mp4", { kind: "video", modifiedAt: 8 }),
      entry("old", { kind: "folder", modifiedAt: 10, children: 1 }),
      entry(".env.png", { secret: true, modifiedAt: 11 }),
      entry("latest.png", { link: true, modifiedAt: 12 }),
    ]
    const names = (kind: Parameters<typeof stepsOf>[1], sort: Parameters<typeof stepsOf>[2]) =>
      stepsOf(entries, kind, sort).map(({ name }) => name)

    it("are those of the file's own kind, in the folder's sort, newest first by default", () => {
      expect(names("image", "newest")).toEqual(["a.png", "c.png", "b.png"])
      expect(names("image", "name")).toEqual(["a.png", "b.png", "c.png"])
      expect(names("image", "size")).toEqual(["a.png", "c.png", "b.png"])
      expect(names("video", "newest")).toEqual(["clip.mp4"])
    })

    it("never include a folder, a file that may hold secrets or a link out of the folder", () => {
      expect(names("image", "newest")).not.toContain("old")
      expect(names("image", "newest")).not.toContain(".env.png")
      expect(names("image", "newest")).not.toContain("latest.png")
    })

    it("count a text file and any other as files, as attaching one opens it", () => {
      const mixed = [
        entry("notes.md", { kind: "text", modifiedAt: 3 }),
        entry("data.bin", { kind: "other", modifiedAt: 2 }),
        entry("a.png", { modifiedAt: 9 }),
      ]
      expect(stepsOf(mixed, "file", "newest").map(({ name }) => name)).toEqual([
        "notes.md",
        "data.bin",
      ])
    })

    it("stand either side of a file, none past the first or last, and none where it isn't listed", () => {
      const steps = stepsOf(entries, "image", "newest")
      expect(neighboursOf(steps, "c.png")).toEqual({ before: steps[0], after: steps[2] })
      expect(neighboursOf(steps, "a.png")).toEqual({ before: undefined, after: steps[1] })
      expect(neighboursOf(steps, "b.png")).toEqual({ before: steps[1], after: undefined })
      expect(neighboursOf(steps, ".env.png")).toBeUndefined()
    })
  })

  it("names a file by the last name of its path, with either separator", () => {
    expect(fileNameOf("/tmp/render/a.png")).toBe("a.png")
    expect(fileNameOf("C:\\Users\\me\\a.png")).toBe("a.png")
  })
})
