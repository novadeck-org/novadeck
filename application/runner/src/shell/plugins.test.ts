import { spawnSync, type SpawnSyncReturns } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { AgentName } from "@novadeck/protocol"

import { plugin, type Start } from "../harnesses/harness.js"
import { harnesses } from "../harnesses/registry.js"
import { describe, expect, it as base } from "../test.js"
import { installShellFiles } from "./install.js"
import { mcpVersions } from "./mcp.js"
import { mcpStart, shellPaths, type ShellPaths } from "./scripts.js"

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
  return spawnSync(program, args, { env, input: stdin, encoding: "utf8", timeout: hookMs })
}

// PowerShell, which runs Claude Code's hook on Windows, can take most of 15 s to start
// cold on a busy CI runner; a hook that hangs still fails.
const hookMs = 45_000

const timedOut = (result: SpawnSyncReturns<string>) =>
  (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT"

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
    it(
      `do nothing outside NovaDeck's shells for ${agent}`,
      ({ plugins }) => {
        const result = runHook(agent, events[agent], undefined, "{}")
        // A shell that ran past hookMs says so here, not as a missing status. Other errors
        // can stand: a hook that never reads its input leaves the agent's write unread.
        expect(timedOut(result)).toBe(false)
        expect(result.status).toBe(0)
        // Antigravity reads a hook's answer as JSON.
        expect(result.stdout.trim()).toBe(agent === "agy" ? "{}" : "")
        expect(plugins.recorded()).toBeUndefined()
      },
      hookMs + 5_000,
    )

    it(
      `hand the agent's payload to NovaDeck's hook for ${agent}`,
      ({ plugins }) => {
        const payload = JSON.stringify({ session_id: "abc", conversationId: "abc" })
        const result = runHook(agent, events[agent], plugins.launcher, payload)
        expect(timedOut(result)).toBe(false)
        expect(result.status).toBe(0)
        expect(plugins.recorded()).toEqual({
          args: [agent, events[agent]],
          stdin: expect.stringContaining(payload),
        })
      },
      hookMs + 5_000,
    )
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
    expect(Object.keys(read(claude, "novadeck", "hooks", "hooks.json").hooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "PermissionRequest",
      "PostToolUse",
      "PostToolUseFailure",
    ])
    expect(read(codex, "novadeck", ".codex-plugin", "plugin.json")).toMatchObject({
      name: "novadeck",
      hooks: "./hooks/hooks.json",
    })
    const codexHooks = read(codex, "novadeck", "hooks", "hooks.json").hooks
    expect(codexHooks.SessionStart[0]).toMatchObject({
      matcher: "startup|resume|clear|compact|fork",
    })
    expect(Object.keys(codexHooks)).toEqual([
      "SessionStart",
      "UserPromptSubmit",
      "Stop",
      "Interrupt",
      "SubagentStart",
      "SubagentStop",
      "PermissionRequest",
      "PostToolUse",
    ])
    expect(read(agy, "plugin.json")).toEqual({ name: "novadeck" })
    expect(Object.keys(read(agy, "hooks.json").novadeck)).toEqual([
      "PreInvocation",
      "Stop",
      "PostToolUse",
    ])
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

// NovaDeck's MCP server, as a plugin's MCP configuration declares it.
const server = (root: string, path: string) =>
  (
    JSON.parse(readFileSync(join(root, path), "utf8")) as {
      mcpServers: { novadeck: { command: string; args?: string[]; env_vars?: string[] } }
    }
  ).mcpServers.novadeck

// The MCP server each agent's plugin declares on this platform for NovaDeck's folder.
const declared = (platform: NodeJS.Platform, directory: string) =>
  [
    ["claude", join("novadeck", ".mcp.json")],
    ["codex", join("novadeck", ".mcp.json")],
    ["agy", "mcp_config.json"],
  ].map(([agent, path]) => {
    const file = harnesses[agent as AgentName]
      .files(platform, { mcp: mcpStart(shellPaths(directory, platform), platform) })
      .find((each) => each.path === path)!
    const { command, args } = (JSON.parse(file.content) as { mcpServers: { novadeck: Start } })
      .mcpServers.novadeck
    return { command, args }
  })

// How sh starts the terminal's own launcher, else the one after it, on Linux and macOS.
const sh = ["-c", 'if [ -x "$NOVADECK_MCP" ]; then exec "$NOVADECK_MCP"; fi; exec "$0" "$@"']

// This environment without the variables of a NovaDeck terminal the tests may run in.
const outside = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("NOVADECK_")))

describe("NovaDeck's MCP server in each agent's plugin", () => {
  it("starts the terminal's MCP launcher, else this one's, with the terminal's variables for Codex", ({
    plugins: { paths },
  }) => {
    const claude = server(paths.plugins.claude, join("novadeck", ".mcp.json"))
    const codex = server(paths.plugins.codex, join("novadeck", ".mcp.json"))
    const agy = server(paths.plugins.agy, "mcp_config.json")
    // Agents start it without a shell: on Windows the relay itself, as a launcher there
    // would keep cmd running beside it.
    for (const each of [claude, codex, agy])
      if (process.platform === "win32") {
        expect(each.command).toBe(paths.relay)
        expect(each.args).toEqual(["mcp", plugin.version, ...mcpVersions])
      } else expect(each).toMatchObject({ command: "/bin/sh", args: [...sh, paths.mcp] })
    expect(codex.env_vars).toEqual([
      "NOVADECK_MCP",
      "NOVADECK_TERMINAL_ID",
      "NOVADECK_REPORT",
      "NOVADECK_REPORT_TOKEN",
    ])
    const manifest = JSON.parse(
      readFileSync(join(paths.plugins.codex, "novadeck", ".codex-plugin", "plugin.json"), "utf8"),
    ) as { mcpServers?: string }
    expect(manifest.mcpServers).toBe("./.mcp.json")
  })

  // Agents read this command from a plugin installed by whichever build connected them
  // last: change it on purpose only.
  it("changes only on purpose", () => {
    for (const platform of ["linux", "darwin"] as const)
      for (const each of declared(platform, "/home/jo doe/it's $HOME/shell"))
        expect(each).toEqual({
          command: "/bin/sh",
          args: [
            "-c",
            'if [ -x "$NOVADECK_MCP" ]; then exec "$NOVADECK_MCP"; fi; exec "$0" "$@"',
            // Joined as the runner joins it, so on a Windows host with its separator.
            shellPaths("/home/jo doe/it's $HOME/shell", platform).mcp,
          ],
        })
    for (const each of declared("win32", "C:\\Users\\Jo Doe\\AppData\\Roaming\\NovaDeck\\shell"))
      expect(each).toEqual({
        command: join("C:\\Users\\Jo Doe\\AppData\\Roaming\\NovaDeck\\shell", "novadeck-relay.exe"),
        args: ["mcp", plugin.version, ...mcpVersions],
      })
  })

  // Windows' plugins start the relay itself, which reads no NOVADECK_MCP.
  it.skipIf(windows)(
    "starts the launcher NOVADECK_MCP names, as in another build's terminal",
    ({ plugins }) => {
      const { command, args } = server(plugins.paths.plugins.claude, join("novadeck", ".mcp.json"))
      const result = spawnSync(command, args ?? [], {
        env: { ...outside(), NOVADECK_MCP: plugins.launcher },
        input: "hello",
        encoding: "utf8",
        timeout: hookMs,
      })
      expect(result.status).toBe(0)
      expect(plugins.recorded()).toEqual({ args: [], stdin: "hello" })
    },
  )

  it.skipIf(windows)(
    "starts its own launcher when NOVADECK_MCP names one that is gone, as a stale copy of its terminal's",
    ({ plugins }) => {
      const { command, args } = server(plugins.paths.plugins.claude, join("novadeck", ".mcp.json"))
      const gone = join(tmpdir(), "novadeck-gone", "mcp")
      const result = spawnSync(command, args ?? [], {
        env: { ...outside(), NOVADECK_MCP: gone },
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        encoding: "utf8",
        timeout: hookMs,
      })
      expect(result.status).toBe(0)
      expect(JSON.parse(String(result.stdout))).toMatchObject({
        id: 1,
        result: { serverInfo: { name: "novadeck" } },
      })
    },
  )

  it(
    "starts its own launcher without NOVADECK_MCP, from a folder whose name needs quoting",
    async ({ resources, plugins }) => {
      const root = mkdtempSync(
        join(tmpdir(), windows ? "novadeck Jo Doe (x) " : `novadeck it's "$x" `),
      )
      resources.defer(() => rmSync(root, { recursive: true, force: true }))
      const paths = await installShellFiles(join(root, "shell"))
      const { command, args } = server(paths.plugins.claude, join("novadeck", ".mcp.json"))
      const result = spawnSync(command, args ?? [], {
        env: outside(),
        input: `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        encoding: "utf8",
        timeout: hookMs,
      })
      expect(result.status).toBe(0)
      // Outside NovaDeck's terminals the relay answers the handshake itself.
      expect(JSON.parse(result.stdout)).toMatchObject({
        id: 1,
        result: { serverInfo: { name: "novadeck" } },
      })
      expect(plugins.recorded()).toBeUndefined()
    },
    hookMs + 5_000,
  )
})
