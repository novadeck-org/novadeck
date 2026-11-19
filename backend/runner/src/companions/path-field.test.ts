import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"

import { companionLimits, folderMatchLimits, maxWroteFolders } from "@novadeck/protocol"
import { vi } from "vitest"

import { it as base, describe, expect } from "../test.js"
import { abbreviateHome, expandHome, matchFolders, wroteFolders, type Wrote } from "./path-field.js"
import { folderSecrets } from "./secrets.js"

const it = base.extend<{ directory: string }>({
  directory: async ({ resources }, use) => {
    const directory = realpathSync.native(mkdtempSync(join(tmpdir(), "novadeck-path-field-")))
    resources.defer(() => rmSync(directory, { recursive: true, force: true }))
    await use(directory)
  },
})

const secret = folderSecrets({})
const none = new Set<string>()
const folder = (...parts: string[]) => {
  const made = join(...parts)
  mkdirSync(made, { recursive: true })
  return made
}

describe("a path with a home folder", () => {
  it("expands a leading tilde, alone or before a separator, and no other", () => {
    const home = join(sep, "home", "u")
    expect(expandHome("~", home)).toBe(home)
    expect(expandHome("~/work", home)).toBe(join(home, "work"))
    expect(expandHome("~work", home)).toBe("~work")
    expect(expandHome("a/~", home)).toBe("a/~")
  })

  it("is written with a tilde under the home folder, and as it is elsewhere", () => {
    const home = join(sep, "home", "u")
    expect(abbreviateHome(join(home, ".cache", "probe"), home)).toBe("~/.cache/probe")
    expect(abbreviateHome(home, home)).toBe("~")
    expect(abbreviateHome(join(sep, "tmp", "x"), home)).toBe(join(sep, "tmp", "x"))
    expect(abbreviateHome(join(sep, "home", "uu"), home)).toBe(join(sep, "home", "uu"))
  })
})

describe("the folders a typed path may be", () => {
  it("names the folders whose names start as the last part does, in any case, by name", async ({
    directory,
  }) => {
    folder(directory, "render")
    folder(directory, "Release-notes")
    folder(directory, "other")
    writeFileSync(join(directory, "readme.md"), "")
    folder(directory, "render", "frames")
    writeFileSync(join(directory, "render", "a.png"), "")
    const typed = `${directory}${sep}re`
    const found = await matchFolders(typed, directory, secret, none)
    expect(found).toEqual([
      { path: `${directory}${sep}Release-notes`, count: 0, open: false },
      { path: `${directory}${sep}render`, count: 2, open: false },
    ])
  })

  it("names every folder of a path that ends in a separator, and marks those already open", async ({
    directory,
  }) => {
    folder(directory, "a")
    const real = folder(directory, "b")
    const found = await matchFolders(`${directory}/`, directory, secret, new Set([real]))
    expect(found.map(({ path, open }) => [path, open])).toEqual([
      [`${directory}/a`, false],
      [`${directory}/b`, true],
    ])
  })

  it("reads a relative path from the terminal's directory and keeps it as it was typed", async ({
    directory,
  }) => {
    folder(directory, "src", "components")
    expect((await matchFolders("src/co", directory, secret, none)).map(({ path }) => path)).toEqual(
      ["src/components"],
    )
    expect((await matchFolders("sr", directory, secret, none)).map(({ path }) => path)).toEqual([
      "src",
    ])
    expect((await matchFolders("../", join(directory, "src"), secret, none)).length).toBe(1)
  })

  it("reads a tilde from the home folder, alone too", async ({ directory }) => {
    folder(directory, "Downloads")
    vi.stubEnv("HOME", directory)
    vi.stubEnv("USERPROFILE", directory)
    try {
      const found = await matchFolders("~/Down", "/", secret, none)
      expect(found.map(({ path }) => path)).toEqual(["~/Downloads"])
      expect((await matchFolders("~", "/", secret, none)).map(({ path }) => path)).toEqual([
        "~/Downloads",
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it("leaves a dot folder out unless the last part starts one", async ({ directory }) => {
    folder(directory, ".cache")
    folder(directory, "cache")
    const all = await matchFolders(`${directory}/`, directory, secret, none)
    expect(all.map(({ path }) => path)).toEqual([`${directory}/cache`])
    const dotted = await matchFolders(`${directory}/.ca`, directory, secret, none)
    expect(dotted.map(({ path }) => path)).toEqual([`${directory}/.cache`])
  })

  it("never names a folder that may hold secrets, nor lists in one", async ({ directory }) => {
    const keys = folder(directory, ".ssh")
    folder(keys, "inner")
    folder(directory, "visible")
    const typed = `${directory}/`
    expect((await matchFolders(`${typed}.s`, directory, secret, none)).length).toBe(0)
    expect((await matchFolders(`${keys}/`, directory, secret, none)).length).toBe(0)
    expect(
      (await matchFolders(`${typed}`, directory, secret, none)).map(({ path }) => path),
    ).toEqual([`${typed}visible`])
  })

  it("never names a folder a link leads to that may hold secrets, but one that is fine", async ({
    directory,
  }) => {
    const keys = folder(directory, "keys", ".ssh")
    const fine = folder(directory, "fine")
    try {
      symlinkSync(keys, join(directory, "to-keys"), "dir")
      symlinkSync(fine, join(directory, "to-fine"), "dir")
    } catch {
      // A platform that won't make a link here has nothing to check.
      return
    }
    writeFileSync(join(directory, "to-file"), "")
    const found = await matchFolders(`${directory}/to-`, directory, secret, none)
    expect(found.map(({ path }) => path)).toEqual([`${directory}/to-fine`])
  })

  it("names none for a parent that isn't there, or isn't a folder, or nothing typed", async ({
    directory,
  }) => {
    writeFileSync(join(directory, "file"), "")
    expect(await matchFolders(`${directory}/nope/x`, directory, secret, none)).toEqual([])
    expect(await matchFolders(`${directory}/file/x`, directory, secret, none)).toEqual([])
    expect(await matchFolders("", directory, secret, none)).toEqual([])
  })

  it("names no folder whose path would be past what the protocol carries", async ({
    directory,
  }) => {
    folder(directory, "a")
    const long = "x".repeat(200)
    folder(directory, long)
    folder(directory, "short")
    // A typed path that detours through `a/..`, so it is long and still names the folder.
    const typed = `${directory}/${"a/../".repeat(780)}`
    expect(typed.length + long.length).toBeGreaterThan(companionLimits.path)
    const found = await matchFolders(typed, directory, secret, none)
    expect(found.map(({ path }) => path.slice(typed.length))).toEqual(["a", "short"])
  })

  it("names at most twenty, and counts a folder's entries only up to a bound", async ({
    directory,
  }) => {
    for (let index = 0; index < 30; index += 1)
      folder(directory, `d${String(index).padStart(2, "0")}`)
    const found = await matchFolders(`${directory}/d`, directory, secret, none)
    expect(found).toHaveLength(folderMatchLimits.matches)
    expect(found[0]!.path).toBe(`${directory}/d00`)
    expect(found.at(-1)!.path).toBe(`${directory}/d19`)
    const big = folder(directory, "big")
    for (let index = 0; index < folderMatchLimits.counted + 5; index += 1)
      writeFileSync(join(big, `f${index}`), "")
    const counted = await matchFolders(`${directory}/bi`, directory, secret, none)
    expect(counted[0]!.count).toBe(folderMatchLimits.counted)
  })
})

describe("the folders agents wrote in outside the project", () => {
  const wrote = (folderPath: string, at: number, over: Partial<Wrote> = {}): Wrote => ({
    folder: folderPath,
    at,
    handle: "moth",
    agent: "claude",
    cwd: join(sep, "nowhere"),
    ...over,
  })

  it("lists the latest first, once each, with who wrote and when", async ({ directory }) => {
    const project = folder(directory, "project")
    const a = folder(directory, "a")
    const b = folder(directory, "b")
    const found = await wroteFolders(
      [wrote(a, 1), wrote(b, 5, { handle: "owl", agent: "codex" }), wrote(a, 9)],
      project,
      secret,
    )
    expect(found).toEqual([
      { path: a, handle: "moth", agent: "claude", at: 9 },
      { path: b, handle: "owl", agent: "codex", at: 5 },
    ])
  })

  it("leaves out the project, the folder the terminal works in, secrets and what is gone", async ({
    directory,
  }) => {
    const project = folder(directory, "project")
    const inside = folder(project, "src")
    const own = folder(directory, "worktree", "src")
    const keys = folder(directory, ".ssh")
    const gone = join(directory, "gone")
    const kept = folder(directory, "kept")
    const found = await wroteFolders(
      [
        wrote(inside, 5),
        wrote(project, 5),
        wrote(own, 5, { cwd: join(directory, "worktree") }),
        wrote(keys, 5),
        wrote(join(keys, "deeper"), 5),
        wrote(gone, 5),
        wrote("relative/dir", 5),
        wrote(kept, 1),
      ],
      project,
      secret,
    )
    expect(found.map(({ path }) => path)).toEqual([kept])
  })

  it("keeps at most eight", async ({ directory }) => {
    const project = folder(directory, "project")
    const each = Array.from({ length: 12 }, (_, index) =>
      wrote(folder(directory, `f${index}`), index),
    )
    const found = await wroteFolders(each, project, secret)
    expect(found).toHaveLength(maxWroteFolders)
    expect(found[0]!.at).toBe(11)
  })
})
