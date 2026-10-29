import {
  chmodSync,
  copyFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach } from "vitest"

import { context, describe, expect, it } from "../test"
import { swapAppImage, type SwapFiles } from "./appimage-swap"
import { fileIdentity } from "./update-state"

let folder: string

beforeEach(async () => {
  folder = await mkdtemp(join(tmpdir(), "novadeck-swap-"))
})
afterEach(() => rm(folder, { recursive: true, force: true }))

// An AppImage is swapped on Linux alone; Windows has no inodes to tell the file by, and
// won't rename over a file that is open.
const posix = it.skipIf(process.platform === "win32")

describe("swapping the AppImage for the update", () => {
  posix(
    "renames the update over the file in one step and says how the file then looks",
    async () => {
      const target = join(folder, "novadeck.AppImage")
      const update = join(folder, "download.AppImage")
      await writeFile(target, "old")
      await writeFile(update, "new")
      await chmod(update, 0o755)
      const before = fileIdentity(await stat(update))
      const steps: string[] = []
      const identity = swapAppImage(update, target, {
        rename: (from, to) => {
          steps.push("rename")
          return renameThrough(from, to)
        },
        copy: () => void steps.push("copy"),
        chmod: () => void steps.push("chmod"),
        remove: () => void steps.push("remove"),
        identity: (path) => fileIdentity(statSync(path)),
      })
      expect(steps).toEqual(["rename"])
      expect(identity).toBe(before)
      expect(await readFile(target, "utf8")).toBe("new")
      expect((await stat(target)).mode & 0o111).not.toBe(0)
    },
  )

  posix("leaves the running image readable: its open file keeps the old contents", async () => {
    const target = join(folder, "novadeck.AppImage")
    const update = join(folder, "download.AppImage")
    await writeFile(target, "old")
    await writeFile(update, "new")
    const running = await open(target, "r")
    try {
      swapAppImage(update, target)
      expect((await running.readFile()).toString()).toBe("old")
    } finally {
      await running.close()
    }
  })

  it("never leaves a moment with no file at the path", async () => {
    const target = join(folder, "novadeck.AppImage")
    const update = join(folder, "download.AppImage")
    await writeFile(target, "old")
    await writeFile(update, "new")
    const seen: boolean[] = []
    swapAppImage(update, target, {
      ...real,
      rename: (from, to) => {
        seen.push(existsSync(target))
        real.rename(from, to)
        seen.push(existsSync(target))
      },
    })
    expect(seen).toEqual([true, true])
  })

  context("the update on another file system", () => {
    it("copies it beside the file, renames that over, and removes the download", () => {
      const target = join(folder, "novadeck.AppImage")
      const update = join(folder, "download.AppImage")
      writeFileSync(target, "old")
      writeFileSync(update, "new")
      let crossed = false
      swapAppImage(update, target, {
        ...real,
        rename: (from, to) => {
          if (from === update && !crossed) {
            crossed = true
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
          }
          real.rename(from, to)
        },
      })
      expect(readFileSync(target, "utf8")).toBe("new")
      expect(readdirSync(folder)).toEqual(["novadeck.AppImage"])
    })

    it("leaves the old file whole and no stray copy when the copy fails", () => {
      const target = join(folder, "novadeck.AppImage")
      const update = join(folder, "download.AppImage")
      writeFileSync(target, "old")
      writeFileSync(update, "new")
      expect(() =>
        swapAppImage(update, target, {
          ...real,
          rename: () => {
            throw Object.assign(new Error("cross-device"), { code: "EXDEV" })
          },
          copy: (from, to) => {
            real.copy(from, to)
            throw new Error("disk full")
          },
        }),
      ).toThrow("disk full")
      expect(readFileSync(target, "utf8")).toBe("old")
      expect(readdirSync(folder).toSorted()).toEqual(["download.AppImage", "novadeck.AppImage"])
    })
  })

  it("fails and touches nothing when the folder can't be written", () => {
    const target = join(folder, "novadeck.AppImage")
    const update = join(folder, "download.AppImage")
    writeFileSync(target, "old")
    writeFileSync(update, "new")
    expect(() =>
      swapAppImage(update, target, {
        ...real,
        rename: () => {
          throw Object.assign(new Error("denied"), { code: "EACCES" })
        },
      }),
    ).toThrow("denied")
    expect(readFileSync(target, "utf8")).toBe("old")
  })

  it("still succeeds when the file can't be identified after it is in place", () => {
    const target = join(folder, "novadeck.AppImage")
    const update = join(folder, "download.AppImage")
    writeFileSync(target, "old")
    writeFileSync(update, "new")
    const identity = swapAppImage(update, target, {
      ...real,
      identity: () => {
        throw new Error("gone")
      },
    })
    expect(identity).toBeUndefined()
    expect(readFileSync(target, "utf8")).toBe("new")
  })

  it("refuses a path that is not absolute", () => {
    expect(() => swapAppImage("a", "novadeck.AppImage")).toThrow("absolute")
  })
})

// The real file system, as the module uses it, for the tests that wrap one step.
const real: SwapFiles = {
  rename: renameSync,
  copy: copyFileSync,
  chmod: chmodSync,
  remove: (path) => rmSync(path, { force: true }),
  identity: (path) => fileIdentity(statSync(path)),
}
const renameThrough = renameSync
