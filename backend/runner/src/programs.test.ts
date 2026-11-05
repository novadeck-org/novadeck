import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative } from "node:path"

import { cmdPath, findProgram } from "./programs.js"
import { describe, expect, it as base } from "./test.js"

const windows = process.platform === "win32"

const it = base.extend<{ folder: (name: string, ...files: string[]) => string }>({
  folder: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-programs-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    await use((name, ...files) => {
      const folder = join(root, name)
      mkdirSync(folder)
      for (const file of files) writeFileSync(join(folder, file), "", { mode: 0o755 })
      return folder
    })
  },
})

describe("finding a program on PATH", () => {
  it("takes the first absolute entry that holds it, by its absolute path", ({ folder }) => {
    const empty = folder("empty")
    const first = folder("first", "tool", "tool.cmd")
    const second = folder("second", "tool", "tool.cmd")
    const PATH = [empty, first, second].join(windows ? ";" : ":")
    expect(findProgram("tool", { env: { PATH } })).toBe(join(first, windows ? "tool.cmd" : "tool"))
    expect(findProgram("missing", { env: { PATH } })).toBeUndefined()
  })

  it("never looks in a relative entry, which names the working folder or one under it", ({
    folder,
  }) => {
    const planted = folder("planted", "git", "git.exe")
    // The folder as the runner's working folder reaches it; on another drive, none does.
    const reached = relative(process.cwd(), planted)
    const entries = isAbsolute(reached) ? ["."] : [".", reached]
    expect(findProgram("git", { env: { PATH: entries.join(windows ? ";" : ":") } })).toBeUndefined()
    expect(
      findProgram("git", { env: { PATH: entries.join(";") }, platform: "win32" }),
    ).toBeUndefined()
    // Absolute, the same folder is found.
    expect(findProgram("git", { env: { PATH: planted } })).toBe(
      join(planted, windows ? "git.exe" : "git"),
    )
  })

  it("on Windows, tries PATHEXT's extensions and never npm's extensionless sh script", ({
    folder,
  }) => {
    const npm = folder("npm", "claude", "claude.cmd", "claude.ps1")
    const quoted = `"${folder("quoted", "codex.exe")}"`
    const env = { Path: [npm, quoted].join(";"), PATHEXT: ".COM;.EXE;.BAT;.CMD" }
    expect(findProgram("claude", { env, platform: "win32" })).toBe(join(npm, "claude.cmd"))
    expect(findProgram("codex", { env, platform: "win32" })).toBe(
      join(quoted.slice(1, -1), "codex.exe"),
    )
    // Named with an extension of its own, it is taken as it is.
    expect(findProgram("claude.ps1", { env, platform: "win32" })).toBe(join(npm, "claude.ps1"))
    expect(findProgram("claude", { env, platform: "win32", extensions: [".exe"] })).toBeUndefined()
  })

  it("on Windows, reads the PATH a child would get of several spellings, the one that sorts first", ({
    folder,
  }) => {
    const chosen = folder("chosen", "agy.cmd")
    const other = folder("other", "agy.cmd")
    const env = { Path: other, PATH: chosen }
    expect(findProgram("agy", { env, platform: "win32" })).toBe(join(chosen, "agy.cmd"))
  })
})

describe("Windows' cmd.exe", () => {
  it("is the absolute ComSpec, whatever its case, else System32's", () => {
    expect(cmdPath({ ComSpec: "C:\\Windows\\system32\\cmd.exe" })).toBe(
      "C:\\Windows\\system32\\cmd.exe",
    )
    expect(cmdPath({ COMSPEC: "cmd.exe", SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\cmd.exe",
    )
    expect(cmdPath({})).toBe("C:\\Windows\\System32\\cmd.exe")
  })
})
