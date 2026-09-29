import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"
import type { ShellPaths } from "./scripts.js"

const windows = process.platform === "win32"

type Fixture = {
  paths: ShellPaths
  /** A stand-in launcher that records its arguments and stdin. */
  launcher: string
  recorded: () => { args: string[]; stdin: string } | undefined
}

const it = base.extend<{ plugins: Fixture }>({
  plugins: async ({ resources }, use) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck-plugins-"))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = await installShellFiles(join(root, "shell"))
    const log = join(root, "launched.json")
    const recorder = join(root, "record.cjs")
    writeFileSync(
      recorder,
      [
        'let stdin = ""',
        'process.stdin.on("data", (chunk) => (stdin += chunk))',
        `process.stdin.on("end", () => require("node:fs").writeFileSync(${JSON.stringify(log)}, JSON.stringify({ args: process.argv.slice(2), stdin })))`,
      ].join("\n"),
    )
    const launcher = join(root, windows ? "launcher.cmd" : "launcher")
    writeFileSync(
      launcher,
      windows
        ? `@"${process.execPath}" "${recorder}" %*\r\n`
        : `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`,
      { mode: 0o755 },
    )
    const recorded = () => {
      try {
        return JSON.parse(readFileSync(log, "utf8")) as { args: string[]; stdin: string }
      } catch {
        return undefined
      }
    }
    await use({ paths, launcher, recorded })
  },
})

// Runs a plugin's hook command the way its agent does: sh -c for Claude Code and
// Antigravity, the login shell for Codex; PowerShell for Claude Code and cmd for the
// others on Windows.
const runHook = (agent: AgentName, event: string, hook: string | undefined, stdin: string) => {
  const { NOVADECK_HOOK: _outer, ...rest } = process.env
  const env = hook ? { ...rest, NOVADECK_HOOK: hook } : rest
  const command = harnesses[agent].hook(process.platform, event)
  const [program, args] = windows
    ? agent === "claude"
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command]]
      : [process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", command]]
    : ["/bin/sh", ["-c", command]]
  return spawnSync(program, args, { env, input: stdin, encoding: "utf8", timeout: 15_000 })
}

// The event each plugin registers today.
const events = { claude: "SessionStart", codex: "SessionStart", agy: "PreInvocation" } as const

describe("agent plugin hook commands", () => {
  // Codex and Antigravity trust a hook by its definition, so a change asks whoever
  // connected them to review NovaDeck's hook again: change these on purpose only.
  it("change only on purpose", () => {
    expect(harnesses.claude.hook("linux", "SessionStart")).toBe(
      '[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" claude SessionStart || true',
    )
    expect(harnesses.codex.hook("linux", "SessionStart")).toBe(
      '[ -n "$NOVADECK_HOOK" ] && "$NOVADECK_HOOK" codex SessionStart || true',
    )
    expect(harnesses.agy.hook("linux", "PreInvocation")).toBe(
      `if [ -n "$NOVADECK_HOOK" ]; then "$NOVADECK_HOOK" agy PreInvocation; else echo '{}'; fi`,
    )
    expect(harnesses.claude.hook("win32", "SessionStart")).toBe(
      "if ($env:NOVADECK_HOOK) { & $env:NOVADECK_HOOK claude SessionStart }",
    )
    expect(harnesses.codex.hook("win32", "SessionStart")).toBe(
      "if defined NOVADECK_HOOK %NOVADECK_HOOK% codex SessionStart",
    )
    expect(harnesses.agy.hook("win32", "PreInvocation")).toBe(
      "if defined NOVADECK_HOOK (%NOVADECK_HOOK% agy PreInvocation) else (echo {})",
    )
  })

  for (const agent of ["claude", "codex", "agy"] as const) {
    it(`do nothing outside NovaDeck's shells for ${agent}`, ({ plugins }) => {
      const result = runHook(agent, events[agent], undefined, "{}")
      expect(result.status).toBe(0)
      // Antigravity reads a hook's answer as JSON.
      expect(result.stdout.trim()).toBe(agent === "agy" ? "{}" : "")
      expect(plugins.recorded()).toBeUndefined()
    })

    it(`hand the agent's payload to NovaDeck's hook for ${agent}`, ({ plugins }) => {
      const payload = JSON.stringify({ session_id: "abc", conversationId: "abc" })
      expect(runHook(agent, events[agent], plugins.launcher, payload).status).toBe(0)
      expect(plugins.recorded()).toEqual({
        args: [agent, events[agent]],
        stdin: expect.stringContaining(payload),
      })
    })
  }
})

const read = (...path: string[]) => JSON.parse(readFileSync(join(...path), "utf8"))

describe("agent plugins", () => {
  it("are marketplaces and plugins each agent can install", ({ plugins }) => {
    const { claude, codex, agy } = plugins.paths.plugins
    for (const market of [claude, codex])
      expect(read(market, ".claude-plugin", "marketplace.json")).toMatchObject({
        name: "novadeck",
        plugins: [{ name: "novadeck", source: "./novadeck" }],
      })
    expect(read(claude, "novadeck", ".claude-plugin", "plugin.json")).toMatchObject({
      name: "novadeck",
    })
    expect(read(claude, "novadeck", "hooks", "hooks.json").hooks.SessionStart).toHaveLength(1)
    expect(read(codex, "novadeck", ".codex-plugin", "plugin.json")).toMatchObject({
      name: "novadeck",
      hooks: "./hooks/hooks.json",
    })
    expect(read(codex, "novadeck", "hooks", "hooks.json").hooks.SessionStart[0]).toMatchObject({
      matcher: "startup|resume|clear|compact",
    })
    expect(read(agy, "plugin.json")).toEqual({ name: "novadeck" })
    expect(read(agy, "hooks.json").novadeck.PreInvocation).toHaveLength(1)
  })
})

describe.runIf(windows)("the hook launcher on Windows", () => {
  it("is named without spaces or brackets, so cmd runs it unquoted", async ({ resources }) => {
    const root = mkdtempSync(join(tmpdir(), "novadeck plugins ("))
    resources.defer(() => rmSync(root, { recursive: true, force: true }))
    const paths = await installShellFiles(join(root, "shell"))
    expect(paths.launcher).toMatch(/^[\w.:\\~-]+$/)
  })
})
