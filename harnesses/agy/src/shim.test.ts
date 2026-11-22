import { describe, expect, it } from "vitest"

import { agy } from "./index.js"
import { allowFolder, allowNovadeck, makeCmdShim, posixShim, shippingRules } from "./shim.js"

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

  it("runs agy as it was given outside a session of Novadeck's", () => {
    expect(shim).toContain(':plain\n"%novadeck_real%" %*')
    expect(shim).not.toMatch(/NOVADECK_NARROW/)
  })

  it("passes the person's allow rules with Novadeck's tools added, only where the relay wrote them", () => {
    expect(shim).toContain(
      `set "novadeck_settings=%~dp0..\\${allowFolder}\\%NOVADECK_TERMINAL_ID%.json"`,
    )
    expect(shim).toContain(
      `"%~dp0..\\novadeck-relay.exe" allow "%USERPROFILE%\\.gemini\\antigravity-cli\\settings.json" "${allowNovadeck}" "%novadeck_settings%" >nul 2>nul && set novadeck_with=--settings "%novadeck_settings%"`,
    )
    expect(shim).toContain('"%novadeck_real%" %novadeck_add% %novadeck_with% %*')
  })

  it("skips another Novadeck's shim, which would call this one back", () => {
    expect(shim).toContain('/c:"rem novadeck shim for agy"')
  })
})

describe("where Antigravity gets a shim", () => {
  it("is always there, as every session takes Novadeck's tools through it", () => {
    expect(agy.shims("win32", { cmdPrints: true, cmdShimDir: dir })).toEqual([
      { path: "agy.cmd", content: shim },
    ])
    const plain = agy.shims("win32", { worktreesRoot: "C:\\w" })
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
    expect(cmd).toContain('"%novadeck_real%" %novadeck_add% %novadeck_with% %*')
    const posix = posixShim("/home/it's/.novadeck/worktrees")
    expect(posix).toContain(`novadeck_root='/home/it'\\''s/.novadeck/worktrees'`)
    expect(posix).toContain('[ -d "$novadeck_root" ]')
    expect(posixShim()).toContain("novadeck_root=\n")
  })
})

describe("the shipping gate's rules in the shims", () => {
  it("are passed to the relay only while the gate is on, with the launch's own words after them", () => {
    expect(posixShim()).not.toContain("command(gh pr")
    expect(posixShim(undefined, false)).toBe(posixShim())
    const on = posixShim(undefined, true)
    for (const rule of shippingRules) expect(on).toContain(`'${rule}'`)
    expect(on).toContain(`"$novadeck_settings" '${shippingRules[0]}' '${shippingRules[1]}' -- "$@"`)
    expect(makeCmdShim({})).not.toContain("command(gh pr")
    const windows = makeCmdShim({ gate: true })
    for (const rule of shippingRules) expect(windows).toContain(`"${rule}"`)
    expect(windows).toContain("-- %*")
  })

  it("are the two commands the gate's reader always reads as shipping, written exactly: a glob never matches", () => {
    expect([...shippingRules]).toEqual(["command(gh pr create)", "command(gh pr merge)"])
    for (const rule of shippingRules) expect(rule).not.toContain("*")
  })

  it("are written for no Windows machine where cmd prints, which registers no PreToolUse", () => {
    const machine = { shippingGate: true }
    const found = (extra: object) =>
      agy.shims!("win32", { ...machine, ...extra }).find(({ path }) => path === "agy.cmd")!.content
    expect(found({})).toContain("-- %*")
    expect(found({ cmdPrints: true })).not.toContain("-- %*")
    expect(agy.shims!("linux", machine)[0]!.content).toContain(`'${shippingRules[0]}'`)
  })
})
