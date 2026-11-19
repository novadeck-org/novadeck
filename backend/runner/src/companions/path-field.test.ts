import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, sep, win32 } from "node:path"

import { companionLimits, folderMatchLimits, maxWroteFolders } from "@novadeck/protocol"
import { vi } from "vitest"

import { harnesses } from "../harnesses/registry.js"
import { it as base, describe, expect } from "../test.js"
import {
  abbreviateHome,
  expandHome,
  lies,
  matchFolders,
  wroteFolders,
  type Wrote,
} from "./path-field.js"
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

  // A temporary folder lies under the home on Windows (`AppData\\Local\\Temp`), so "wrote to"
  // shows it with `~` and forward slashes: picking it must open the same folder.
  it("reads back on Windows what it writes there, `~` with forward slashes", () => {
    const home = "C:\\Users\\Ann"
    const temp = "C:\\Users\\Ann\\AppData\\Local\\Temp\\novadeck-outside-1\\b"
    const shown = abbreviateHome(temp, home, win32)
    expect(shown).toBe("~/AppData/Local/Temp/novadeck-outside-1/b")
    expect(expandHome(shown, home, win32)).toBe(temp)
    expect(expandHome("~\\AppData\\Local", home, win32)).toBe("C:\\Users\\Ann\\AppData\\Local")
    expect(expandHome("~", home, win32)).toBe(home)
    // Windows reads the home without case, and a folder on another drive is written whole.
    expect(abbreviateHome("c:\\users\\ann\\Work", home, win32)).toBe("~/Work")
    expect(abbreviateHome("D:\\Ann\\Work", home, win32)).toBe("D:\\Ann\\Work")
    expect(abbreviateHome("C:\\Users\\Annie", home, win32)).toBe("C:\\Users\\Annie")
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
      {
        path: `${directory}${sep}Release-notes`,
        real: join(directory, "Release-notes"),
        count: 0,
        open: false,
      },
      { path: `${directory}${sep}render`, real: join(directory, "render"), count: 2, open: false },
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
      // Its real path is the one a folder item showing it holds, as other lists compare it.
      expect(found.map(({ real }) => real)).toEqual([join(directory, "Downloads")])
      expect(expandHome(found[0]!.path)).toBe(join(directory, "Downloads"))
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
    // Shown with `~` for the home, which a machine's temporary folder may lie in (as on Windows).
    expect(found).toEqual([
      { path: abbreviateHome(a), real: a, handle: "moth", agent: "claude", at: 9 },
      { path: abbreviateHome(b), real: b, handle: "owl", agent: "codex", at: 5 },
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
    expect(found.map(({ real }) => real)).toEqual([kept])
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

// Windows reads either slash and any case, so a write Windows reports lies in the folder a
// harness keeps for itself however each is spelled.
describe("a folder on Windows", () => {
  it("holds what lies under it, by either slash and any case, and nothing beside it", () => {
    const brain = "C:\\Users\\Ann\\.gemini\\antigravity-cli\\brain"
    expect(lies(`${brain}\\c1`, brain, win32)).toBe(true)
    expect(lies(brain, brain, win32)).toBe(true)
    expect(lies("c:/users/ann/.gemini/antigravity-cli/brain/c1", brain, win32)).toBe(true)
    expect(lies(`${brain}-old\\c1`, brain, win32)).toBe(false)
    expect(lies("D:\\Users\\Ann\\.gemini\\antigravity-cli\\brain\\c1", brain, win32)).toBe(false)
    expect(lies("C:\\Users\\Ann\\.gemini", brain, win32)).toBe(false)
  })

  // Each harness's own folders, named from where its transcript lies in a Windows home, hold
  // the folders its agent writes there, and not the person's own folders beside them.
  it.each([
    {
      agent: "claude" as const,
      transcript: "C:\\Users\\Ann\\.claude\\projects\\C--work-p\\s.jsonl",
      kept: ["C:\\Users\\Ann\\.claude\\plans", "C:\\Users\\Ann\\.claude\\agent-memory\\reviewer"],
      listed: "C:\\Users\\Ann\\.claude\\skills\\render",
    },
    {
      agent: "codex" as const,
      transcript: "C:\\Users\\Ann\\.codex\\sessions\\2026\\11\\19\\rollout-1.jsonl",
      kept: ["C:\\Users\\Ann\\.codex\\memories", "C:\\Users\\Ann\\.codex\\log"],
      listed: "C:\\Users\\Ann\\.codex\\generated_images",
    },
    {
      agent: "agy" as const,
      transcript:
        "C:\\Users\\Ann\\.gemini\\antigravity-cli\\brain\\c1\\.system\\logs\\overview.txt",
      kept: [
        "C:\\Users\\Ann\\.gemini\\antigravity-cli\\brain\\c1",
        "c:/users/ann/.gemini/antigravity-cli/brain/c2/artifacts",
      ],
      listed: "C:\\Users\\Ann\\.gemini\\antigravity-cli\\skills",
    },
  ])("keeps $agent's own writes apart", ({ agent, transcript, kept, listed }) => {
    const own = harnesses[agent].bookkeepingOf?.(transcript) ?? []
    expect(own.length).toBeGreaterThan(0)
    for (const folderPath of kept)
      expect(own.some((each) => lies(folderPath, each, win32))).toBe(true)
    expect(own.some((each) => lies(listed, each, win32))).toBe(false)
  })
})
