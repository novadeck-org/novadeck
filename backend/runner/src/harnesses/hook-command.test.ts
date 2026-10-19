import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { agy } from "@novadeck/harness-agy/index"
import { claude } from "@novadeck/harness-claude/index"
import { codex } from "@novadeck/harness-codex/index"
import { hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"

import { describe, expect, it } from "../test.js"

const windows = process.platform === "win32"

/** Runs a hook command in its shell, as the harness that uses it does; its output and exit. */
const run = (dialect: Dialect, command: string, env: NodeJS.ProcessEnv) => {
  const base = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    COMSPEC: process.env.COMSPEC,
    // PowerShell runs a .cmd launcher only as a program PATHEXT names.
    PATHEXT: process.env.PATHEXT,
    ...env,
  }
  const ran =
    dialect === "sh"
      ? spawnSync("sh", ["-c", command], { env: base, encoding: "utf8" })
      : dialect === "powershell"
        ? spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
            env: base,
            encoding: "utf8",
          })
        : // As Antigravity runs it: `cmd /c "<command>"`, its quotes escaped as `\"`, which
          // cmd keeps; verbatim, as Node escapes otherwise.
          spawnSync(
            process.env.COMSPEC ?? "cmd.exe",
            ["/c", `"${command.replaceAll('"', String.raw`\"`)}"`],
            { env: base, encoding: "utf8", windowsVerbatimArguments: true },
          )
  return { status: ran.status, stdout: ran.stdout.trim() }
}

/** A launcher at `folder` that says it ran, with what it was given. */
const launcher = (folder: string, name: string): string => {
  mkdirSync(folder, { recursive: true })
  if (windows) {
    const path = join(folder, `${name}.cmd`)
    writeFileSync(path, "@echo launched %*\r\n")
    return path
  }
  const path = join(folder, name)
  writeFileSync(path, '#!/bin/sh\necho launched "$@"\n', { mode: 0o755 })
  return path
}

const dialects: readonly Dialect[] = windows ? ["powershell", "cmd"] : ["sh"]
const nothing = { status: 0, stdout: "" }

describe("a hook command", () => {
  for (const dialect of dialects)
    it(`runs the launcher in ${dialect}, its own shell`, ({ resources }) => {
      const folder = mkdtempSync(join(tmpdir(), "novadeck-hook-command-"))
      resources.defer(() => rmSync(folder, { recursive: true, force: true }))
      const hook = launcher(folder, "hook")
      for (const fallback of [undefined, "{}"]) {
        const command = hookCommand(dialect, { agent: "agy", event: "Stop", fallback })
        expect(run(dialect, command, { NOVADECK_HOOK: hook })).toEqual({
          status: 0,
          stdout: "launched agy Stop",
        })
      }
    })

  for (const dialect of dialects)
    it(`prints its fallback in ${dialect} where the launcher is unset or gone`, () => {
      const command = hookCommand(dialect, { agent: "agy", event: "Stop", fallback: "{}" })
      const fallback = { status: 0, stdout: "{}" }
      expect(run(dialect, command, {})).toEqual(fallback)
      expect(run(dialect, command, { NOVADECK_HOOK: "" })).toEqual(fallback)
      const gone = windows ? String.raw`C:\nonexistent\hook.cmd` : "/nonexistent/hook"
      expect(run(dialect, command, { NOVADECK_HOOK: gone })).toEqual(fallback)
    })

  for (const dialect of dialects)
    it(`prints nothing in ${dialect} without a fallback, and exits 0`, ({ resources }) => {
      const command = hookCommand(dialect, { agent: "codex", event: "Stop" })
      expect(run(dialect, command, {})).toEqual(nothing)
      const gone = windows ? String.raw`C:\nonexistent\hook.cmd` : "/nonexistent/hook"
      expect(run(dialect, command, { NOVADECK_HOOK: gone })).toEqual(nothing)
      const folder = mkdtempSync(join(tmpdir(), "novadeck-hook-command-"))
      resources.defer(() => rmSync(folder, { recursive: true, force: true }))
      // A launcher named with a space, or an `&`, as a profile folder may be: cmd reads it
      // unquoted, so its line breaks, and it still prints nothing and exits 0.
      for (const named of ["has space", "a&b"]) {
        const hook = launcher(join(folder, named), "hook")
        expect(run(dialect, command, { NOVADECK_HOOK: hook })).toEqual(
          dialect === "cmd" ? nothing : { status: 0, stdout: "launched codex Stop" },
        )
      }
    })

  it("echoes in cmd only a fallback cmd prints as written", () => {
    expect(() => hookCommand("cmd", { agent: "agy", event: "Stop", fallback: '{"a":1}' })).toThrow()
    expect(() => hookCommand("cmd", { agent: "agy", event: "Stop", fallback: "a & b" })).toThrow()
    expect(() => hookCommand("cmd", { agent: "agy", event: "Stop", fallback: "" })).toThrow()
    expect(() => hookCommand("sh", { agent: "agy", event: "Stop; rm" })).toThrow()
  })

  it("is each harness's own, in the dialect it declares", () => {
    expect(claude.hookDialect("win32")).toBe("powershell")
    expect(codex.hookDialect("win32")).toBe("powershell")
    expect(agy.hookDialect("win32")).toBe("cmd")
    for (const harness of [claude, codex, agy])
      for (const platform of ["linux", "darwin"] as const)
        expect(harness.hookDialect(platform)).toBe("sh")
  })
})
