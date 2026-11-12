import { describe, expect, it } from "vitest"

import { agy } from "./index.js"
import { makeCmdShim, posixShim } from "./shim.js"

const dir = "C:\\NOVADE~1\\shell\\agy-cmd"
const shim = makeCmdShim({ cmdShimDir: dir })

describe("the Windows shim", () => {
  it("looks for the real agy on PATH only, never in the current folder where cmd looks first", () => {
    expect(shim).toContain("('where $PATH:agy 2^>nul')")
    expect(shim).not.toMatch(/where agy/)
  })

  it("puts the pass-through's folder first on PATH, inside a Novadeck terminal that names it, under setlocal", () => {
    const lines = shim.split("\n")
    const prepend = lines.indexOf(`set "PATH=${dir};%PATH%"`)
    expect(prepend).toBeGreaterThan(-1)
    // After the checks that this is a Novadeck terminal with Antigravity's shim on, and after
    // the real agy was found on the person's own PATH; the shell keeps its PATH.
    const at = (text: string) => lines.findIndex((line) => line.includes(text))
    expect(prepend).toBeGreaterThan(at("if not defined NOVADECK_TERMINAL_ID"))
    expect(prepend).toBeGreaterThan(at('findstr /c:" agy "'))
    expect(prepend).toBeGreaterThan(at("where $PATH:agy"))
    expect(prepend).toBeGreaterThan(lines.indexOf("setlocal"))
    expect(lines.indexOf(":plain")).toBeGreaterThan(prepend)
  })

  it("runs agy as it was given, with no option of its own", () => {
    expect(shim).toContain('"%novadeck_real%" %*')
    expect(shim).not.toMatch(/--settings|NOVADECK_NARROW/)
  })

  it("skips another Novadeck's shim, which would call this one back", () => {
    expect(shim).toContain('/c:"rem novadeck shim for agy"')
  })
})

describe("where Antigravity gets a shim", () => {
  it("is always on Linux and macOS, and on Windows only where it is needed", () => {
    expect(agy.shims("win32", { cmdPrints: true, cmdShimDir: dir })).toEqual([
      { path: "agy.cmd", content: shim },
    ])
    // A batch file in place of agy.exe only where it is needed.
    expect(agy.shims("win32")).toEqual([])
    expect(agy.shims("win32", { worktreesRoot: "C:\\w", worktreesPresent: false })).toEqual([])
    const plain = agy.shims("win32", { worktreesRoot: "C:\\w", worktreesPresent: true })
    expect(plain.map((file) => file.path)).toEqual(["agy.cmd"])
    expect(plain[0]?.content).not.toContain('set "PATH=')
    for (const platform of ["linux", "darwin"] as const)
      expect(agy.shims(platform, { cmdShimDir: dir }).map((file) => file.path)).toEqual(["agy"])
  })

  it("passes the folder of agents' worktrees on, once it exists", () => {
    const root = "C:\\Users\\x\\.novadeck\\worktrees"
    const cmd = makeCmdShim({ cmdShimDir: dir, root })
    expect(cmd).toContain(`set "novadeck_root=${root}"`)
    expect(cmd).toContain(
      'if exist "%novadeck_root%\\" set novadeck_add=--add-dir="%novadeck_root%"',
    )
    expect(cmd).toContain('"%novadeck_real%" %novadeck_add% %*')
    const posix = posixShim("/home/it's/.novadeck/worktrees")
    expect(posix).toContain(`novadeck_root='/home/it'\\''s/.novadeck/worktrees'`)
    expect(posix).toContain('[ -d "$novadeck_root" ]')
    expect(posixShim()).toContain("novadeck_root=\n")
  })
})
