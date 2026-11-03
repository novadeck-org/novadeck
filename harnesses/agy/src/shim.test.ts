import { describe, expect, it } from "vitest"

import { agy } from "./index.js"
import { makeCmdShim } from "./shim.js"

const dir = "C:\\NOVADE~1\\shell\\agy-cmd"
const shim = makeCmdShim(dir)

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
  it("is Windows only, and only where Novadeck's cmd.exe pass-through is installed", () => {
    expect(agy.shims("win32", { cmdPrints: true, cmdShimDir: dir })).toEqual([
      { path: "agy.cmd", content: shim },
    ])
    // cmd printing without a verified pass-through, and cmd printing nothing, get none.
    expect(agy.shims("win32", { cmdPrints: true })).toEqual([])
    expect(agy.shims("win32")).toEqual([])
    for (const platform of ["linux", "darwin"] as const)
      expect(agy.shims(platform, { cmdShimDir: dir })).toEqual([])
  })
})
