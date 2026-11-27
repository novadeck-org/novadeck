import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { TourError } from "./errors.js"
import {
  chooseTourFolder,
  inTourFolder,
  keepTourFolder,
  resetTourFolder,
  tourFolder,
  tourFolderCount,
  tourMarker,
  withinFolder,
} from "./folder.js"
import { describe, expect, it } from "./test.js"

const scratch = async (resources: { defer: (cleanup: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "novadeck-tour-"))
  resources.defer(() => rm(root, { recursive: true, force: true }))
  return root
}

const conflict = (error: unknown): boolean =>
  error instanceof TourError && error.code === "CONFLICT"

describe("the tour's folder", () => {
  it("lives in .novadeck in the home folder, and is numbered after the first", () => {
    expect(tourFolder("/home/x")).toBe(join("/home/x", ".novadeck", "tour"))
    expect(tourFolder("/home/x", 2)).toBe(join("/home/x", ".novadeck", "tour-2"))
    expect(tourFolder("/home/x", 99)).toBe(join("/home/x", ".novadeck", "tour-99"))
  })

  it("is made with its files and the marker where it is missing", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, { "AGENTS.md": "brief\n" })
    expect((await readdir(folder)).toSorted()).toEqual([tourMarker, "AGENTS.md"].toSorted())
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("brief\n")
  })

  it("writes a file in a folder of its own, and empties it again", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, { ".claude/settings.json": "{}\n" })
    expect(await readFile(join(folder, ".claude", "settings.json"), "utf8")).toBe("{}\n")
    await resetTourFolder(folder, {})
    expect(await readdir(folder)).toEqual([tourMarker])
  })

  it("is emptied of an earlier run's files, folders and all", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, { "AGENTS.md": "old\n" })
    await mkdir(join(folder, "site"))
    await writeFile(join(folder, "site", "index.html"), "<p>old</p>")
    await resetTourFolder(folder, { "AGENTS.md": "new\n" })
    expect((await readdir(folder)).toSorted()).toEqual([tourMarker, "AGENTS.md"].toSorted())
    expect(await readFile(join(folder, "AGENTS.md"), "utf8")).toBe("new\n")
  })

  it("takes over an empty folder", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await mkdir(folder, { recursive: true })
    await resetTourFolder(folder, { "AGENTS.md": "brief\n" })
    expect(await readdir(folder)).toContain(tourMarker)
  })

  it("leaves a folder holding files without the marker as it is", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await mkdir(folder, { recursive: true })
    await writeFile(join(folder, "notes.md"), "mine")
    await expect(resetTourFolder(folder, {})).rejects.toSatisfy(conflict)
    expect(await readdir(folder)).toEqual(["notes.md"])
  })

  it("refuses a file where the folder would be", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await mkdir(join(folder, ".."), { recursive: true })
    await writeFile(folder, "not a folder")
    await expect(resetTourFolder(folder, {})).rejects.toSatisfy(conflict)
  })

  it.skipIf(process.platform === "win32")(
    "refuses a link in its place, leaving what it points to",
    async ({ resources }) => {
      const root = await scratch(resources)
      const elsewhere = join(root, "elsewhere")
      await mkdir(elsewhere)
      await writeFile(join(elsewhere, tourMarker), "")
      await writeFile(join(elsewhere, "keep.md"), "keep")
      const folder = tourFolder(root)
      await mkdir(join(folder, ".."), { recursive: true })
      await symlink(elsewhere, folder)
      await expect(resetTourFolder(folder, {})).rejects.toSatisfy(conflict)
      expect((await readdir(elsewhere)).toSorted()).toEqual([tourMarker, "keep.md"].toSorted())
    },
  )

  it.skipIf(process.platform === "win32")(
    "removes a link inside, never what it points to",
    async ({ resources }) => {
      const root = await scratch(resources)
      const elsewhere = join(root, "elsewhere")
      await mkdir(elsewhere)
      await writeFile(join(elsewhere, "keep.md"), "keep")
      const folder = tourFolder(root)
      await resetTourFolder(folder, {})
      await symlink(elsewhere, join(folder, "linked"))
      await resetTourFolder(folder, {})
      expect(await readdir(folder)).toEqual([tourMarker])
      expect(await readdir(elsewhere)).toEqual(["keep.md"])
    },
  )
})

describe("choosing the tour's folder", () => {
  it("is the first folder where none exists, changing nothing", async ({ resources }) => {
    const root = await scratch(resources)
    expect(await chooseTourFolder(root)).toBe(tourFolder(root))
    await expect(readdir(tourFolder(root))).rejects.toThrow()
  })

  it("takes an empty folder and one that holds the marker", async ({ resources }) => {
    const root = await scratch(resources)
    await mkdir(tourFolder(root), { recursive: true })
    expect(await chooseTourFolder(root)).toBe(tourFolder(root))
    await resetTourFolder(tourFolder(root), { "AGENTS.md": "old\n" })
    expect(await chooseTourFolder(root)).toBe(tourFolder(root))
  })

  it("passes over a folder of files without the marker, whoever's they are", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    await mkdir(tourFolder(root), { recursive: true })
    await writeFile(join(tourFolder(root), "notes.md"), "mine")
    expect(await chooseTourFolder(root)).toBe(tourFolder(root, 2))
    await mkdir(tourFolder(root, 2))
    await writeFile(join(tourFolder(root, 2), "more.md"), "mine")
    expect(await chooseTourFolder(root)).toBe(tourFolder(root, 3))
    expect(await readdir(tourFolder(root))).toEqual(["notes.md"])
  })

  it("passes over a file or a link where a later folder would be, but refuses one in place of the first", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    await mkdir(join(root, ".novadeck"), { recursive: true })
    await writeFile(tourFolder(root), "not a folder")
    await expect(chooseTourFolder(root)).rejects.toSatisfy(conflict)
    await rm(tourFolder(root))
    await mkdir(tourFolder(root))
    await writeFile(join(tourFolder(root), "notes.md"), "mine")
    await writeFile(tourFolder(root, 2), "not a folder")
    expect(await chooseTourFolder(root)).toBe(tourFolder(root, 3))
  })

  it("refuses once every folder is taken", async ({ resources }) => {
    const root = await scratch(resources)
    for (let nth = 1; nth <= tourFolderCount; nth++) {
      const folder = tourFolder(root, nth)
      // eslint-disable-next-line no-await-in-loop -- Made one after the other.
      await mkdir(folder, { recursive: true })
      // eslint-disable-next-line no-await-in-loop -- As above.
      await writeFile(join(folder, "mine.md"), "mine")
    }
    await expect(chooseTourFolder(root)).rejects.toSatisfy(conflict)
  })
})

describe("whether a path is the tour's", () => {
  it("is when it is in one of the tour's folders and the marker is there", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    for (const nth of [1, 2, 99]) {
      // eslint-disable-next-line no-await-in-loop -- Made one after the other.
      await resetTourFolder(tourFolder(root, nth), {})
      // By this computer's own rules for paths: another system's can't read these.
      expect(inTourFolder(tourFolder(root, nth), root)).toBe(true)
      expect(inTourFolder(join(tourFolder(root, nth), "site", "x"), root)).toBe(true)
    }
  })

  it("is not without the marker, in a folder the tour doesn't name, or beside it", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    await mkdir(tourFolder(root), { recursive: true })
    expect(inTourFolder(tourFolder(root), root, "linux")).toBe(false)
    for (const name of ["tour-1", "tour-100", "tour-old", "tour-02", "tours"]) {
      const folder = join(root, ".novadeck", name)
      // eslint-disable-next-line no-await-in-loop -- Made one after the other.
      await resetTourFolder(folder, {})
      expect(inTourFolder(folder, root, "linux")).toBe(false)
    }
    expect(inTourFolder(join(root, ".novadeck"), root, "linux")).toBe(false)
    expect(inTourFolder(join(root, "code"), root, "linux")).toBe(false)
  })

  it.skipIf(process.platform === "win32")("sees it by its real path too", async ({ resources }) => {
    const root = await scratch(resources)
    await resetTourFolder(tourFolder(root), {})
    const linked = join(await scratch(resources), "home")
    await symlink(root, linked)
    expect(inTourFolder(join(root, ".novadeck", "tour"), linked)).toBe(true)
  })

  it("counts a path that differs from the home in case only where the file system does", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    await resetTourFolder(tourFolder(root), {})
    const shouted = join(root, ".NOVADECK", "TOUR", "site")
    expect(inTourFolder(shouted, root, "win32")).toBe(true)
    // The other systems' rules read only their own kind of path, which Windows' aren't.
    if (process.platform === "win32") return
    expect(inTourFolder(shouted, root, "darwin")).toBe(true)
    expect(inTourFolder(shouted, root, "linux")).toBe(false)
  })

  it("is a folder or one inside it, never one beside it", () => {
    expect(withinFolder("/h/.novadeck/tour", "/h/.novadeck/tour", "linux")).toBe(true)
    expect(withinFolder("/h/.novadeck/tour/site/", "/h/.novadeck/tour", "linux")).toBe(true)
    expect(withinFolder("/h/.novadeck/tour-old", "/h/.novadeck/tour", "linux")).toBe(false)
    expect(withinFolder("/h/.novadeck", "/h/.novadeck/tour", "linux")).toBe(false)
  })

  it("tells cases apart only where the file system does", () => {
    expect(withinFolder("/h/.Novadeck/Tour", "/h/.novadeck/tour", "linux")).toBe(false)
    expect(withinFolder("/h/.Novadeck/Tour", "/h/.novadeck/tour", "darwin")).toBe(true)
    expect(
      withinFolder("C:\\Users\\x\\.Novadeck\\TOUR", "c:/users/x/.novadeck/tour", "win32"),
    ).toBe(true)
  })
})

describe("keeping the tour's folder", () => {
  it("drops the tour's settings and the marker, and leaves the files", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, {
      "AGENTS.md": "project\n",
      ".claude/settings.json": "{}\n",
      "src/main.js": "game\n",
    })
    await keepTourFolder(folder)
    expect((await readdir(folder)).toSorted()).toEqual(["AGENTS.md", "src"])
    expect(await readFile(join(folder, "src", "main.js"), "utf8")).toBe("game\n")
  })

  it("keeps the person's own files in .claude", async ({ resources }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, { ".claude/settings.json": "{}\n", ".claude/mine.md": "x" })
    await keepTourFolder(folder)
    expect(await readdir(join(folder, ".claude"))).toEqual(["mine.md"])
  })

  it("leaves a folder without the marker as it is, so a repeat does nothing", async ({
    resources,
  }) => {
    const folder = tourFolder(await scratch(resources))
    await resetTourFolder(folder, { ".claude/settings.json": "{}\n" })
    await keepTourFolder(folder)
    await mkdir(join(folder, ".claude"), { recursive: true })
    await writeFile(join(folder, ".claude", "settings.json"), "mine")
    await keepTourFolder(folder)
    expect(await readFile(join(folder, ".claude", "settings.json"), "utf8")).toBe("mine")
  })

  it("makes a folder a later run passes over", async ({ resources }) => {
    const root = await scratch(resources)
    const folder = tourFolder(root)
    await resetTourFolder(folder, { "src/main.js": "game\n" })
    await keepTourFolder(folder)
    expect(await chooseTourFolder(root)).toBe(tourFolder(root, 2))
  })
})
