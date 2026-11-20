import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DomainError } from "../errors.js"
import { describe, expect, it } from "../test.js"
import { checkTourFolder, resetTourFolder, tourFolder, tourMarker } from "./folder.js"

const scratch = async (resources: { defer: (cleanup: () => Promise<void>) => void }) => {
  const root = await mkdtemp(join(tmpdir(), "novadeck-tour-"))
  resources.defer(() => rm(root, { recursive: true, force: true }))
  return root
}

const conflict = (error: unknown): boolean =>
  error instanceof DomainError && error.code === "CONFLICT"

describe("the tour's folder", () => {
  it("lives in .novadeck in the home folder", () => {
    expect(tourFolder("/home/x")).toBe(join("/home/x", ".novadeck", "tour"))
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

  it("is checked without a change: refused where it isn't the tour's, else left as it is", async ({
    resources,
  }) => {
    const root = await scratch(resources)
    const folder = tourFolder(root)
    await expect(checkTourFolder(folder)).resolves.toBeUndefined()
    await expect(readdir(folder)).rejects.toThrow()
    await resetTourFolder(folder, { "AGENTS.md": "old\n" })
    await expect(checkTourFolder(folder)).resolves.toBeUndefined()
    expect((await readdir(folder)).toSorted()).toEqual([tourMarker, "AGENTS.md"].toSorted())
    const mine = join(root, "mine")
    await mkdir(mine)
    await writeFile(join(mine, "notes.md"), "mine")
    await expect(checkTourFolder(mine)).rejects.toSatisfy(conflict)
    const file = join(root, "file")
    await writeFile(file, "x")
    await expect(checkTourFolder(file)).rejects.toSatisfy(conflict)
    expect(await readdir(mine)).toEqual(["notes.md"])
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
