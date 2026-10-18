import { join } from "node:path"

import { plugin, type Launchers, type Machine, type Start } from "@novadeck/harness-core/harness"
import { header } from "@novadeck/harness-core/header"
import type { AgentName } from "@novadeck/protocol"
import {
  cmdQuote,
  shellScriptPaths,
  shellScripts,
  shQuote,
  type ShellFile,
  type ShellScriptPaths,
} from "@novadeck/terminal/shell"

import { agents, harnesses } from "../harnesses/registry.js"
import { hookVariables } from "./hook.js"
import { mcpVersions } from "./mcp.js"

// The files Novadeck puts in shells it starts, and the plugins agents install when the
// person connects them, as text. They are written into Novadeck's own data directory;
// only connecting an agent installs anything elsewhere, through the agent's own commands.

/** Where each file lives under the shell directory; the shells' own as the library has them. */
export type ShellPaths = ShellScriptPaths & {
  /** Put first on PATH while a harness with shims is connected, as Codex's `codex`. */
  readonly bin: string
  /** The plugin sources each agent installs from when the person connects it. */
  readonly plugins: { readonly [agent in AgentName]: string }
  /** Where a fresh shell finds the command that resumes its agent, one file per shell. */
  readonly resume: string
  /** The hook's launcher, which connected agents' plugins run. */
  readonly hook: string
  /** The MCP server's launcher, which connected agents' plugins start. */
  readonly mcp: string
  /** Novadeck's copy of the relay the launchers start (see application/relay). */
  readonly relay: string
  /** What the runner tells the relay about the agents, which the hook launcher names. */
  readonly relayConfig: string
}

export const shellPaths = (directory: string, platform = process.platform): ShellPaths => ({
  // Their variables and functions are named NOVADECK_RESUME, __novadeck_prompt.
  ...shellScriptPaths(directory, "novadeck"),
  bin: join(directory, "bin"),
  plugins: Object.fromEntries(
    agents.map((agent) => [agent, join(directory, "plugins", harnesses[agent].plugin)]),
  ) as ShellPaths["plugins"],
  resume: join(directory, "resume"),
  hook: join(directory, platform === "win32" ? "hook.cmd" : "hook"),
  mcp: join(directory, platform === "win32" ? "mcp.cmd" : "mcp"),
  relay: join(directory, platform === "win32" ? "novadeck-relay.exe" : "novadeck-relay"),
  relayConfig: join(directory, "relay.json"),
})

/** What older versions wrote beside these files and nothing reads any more. */
export const staleShellFiles = (directory: string): string[] => [
  join(directory, "hook.mjs"),
  join(directory, "mcp.mjs"),
  join(directory, "mcp-idle.js"),
]

// The launchers start Novadeck's relay (see application/relay), which carries an agent's
// hooks and MCP messages to the runner of the terminal it runs in, or, outside Novadeck's
// terminals, answers itself: for the MCP server, the handshake with no tools. Its copy
// lives here, beside them, so it stays when the app's own folder goes (an AppImage's
// mount, a portable build's unpacked copy). The MCP server answers as this version of
// it: its plugin's version, then the MCP versions it speaks, newest first.

// What a hook prints with nothing from Novadeck, by agent and event, as each harness's
// messaging names it, without the line's end.
const silentAnswers = Object.fromEntries(
  agents.map((agent) => [
    agent,
    Object.fromEntries(
      Object.entries(harnesses[agent].messaging.silent).map(([event, text]) => [
        event,
        text.trimEnd(),
      ]),
    ),
  ]),
)

/**
 * What the relay knows of the agents, as `relay.json` holds it: which events wait the long
 * limit for the runner's answer (`asks`: a Stop, or a prompt-time hook, which may hold
 * messages for a lease), what of a hook's environment it forwards, and what each prints
 * without Novadeck. Every hook is sent to the runner and printed what it answers, so a
 * tool-call hook (which asks the runner for the lead's messages, with a deadline) is not
 * listed: it runs after every tool, is answered at once, and keeps a report's short limit,
 * so a runner that can't answer holds a tool up 2 s at most, not 4.
 */
export const relayConfig = {
  asks: Object.fromEntries(
    agents.map((agent) => [
      agent,
      Object.entries(harnesses[agent].messaging.asks)
        .filter(([, kind]) => kind !== "tool")
        .map(([event]) => event),
    ]),
  ),
  env: [...hookVariables],
  fallbacks: silentAnswers,
}

const relayArguments = (paths: ShellPaths) =>
  ({
    hook: ["hook", "--config", paths.relayConfig],
    mcp: ["mcp", plugin.version, ...mcpVersions],
  }) as const

type Mode = keyof ReturnType<typeof relayArguments>

// Each argument as it is, or quoted where the shell would read more into it.
const relayLine = (paths: ShellPaths, mode: Mode, quote: (value: string) => string) => {
  const args: readonly string[] = relayArguments(paths)[mode]
  return args.map((each) => (/^[\w.-]+$/.test(each) ? each : quote(each))).join(" ")
}

// Each agent's answers without Novadeck, events of their own first: as sh's cases, and as
// cmd's lines, which hold none of cmd's own special characters.
const silentCases = (each: (agent: string, event: string, text: string) => string) =>
  agents.flatMap((agent) =>
    Object.entries(silentAnswers[agent] ?? {})
      .filter(([, text]) => text !== "")
      .toSorted(([one], [other]) => Number(one === "*") - Number(other === "*"))
      .map(([event, text]) => {
        if (/[&|<>^%]/.test(text)) throw new Error(`cmd can't print ${text} as it is`)
        return each(agent, event, text)
      }),
  )

const posixLauncher = (paths: ShellPaths, mode: Mode, what: string) =>
  mode === "mcp"
    ? `#!/bin/sh
${header("#", what)}
if [ ! -x ${shQuote(paths.relay)} ]; then
  printf '%s\\n' ${shQuote(`Novadeck's relay is missing at ${paths.relay}; restarting Novadeck puts it back.`)} >&2
  exit 1
fi
exec ${shQuote(paths.relay)} ${relayLine(paths, mode, shQuote)} "$@"
`
    : `#!/bin/sh
${header("#", what)}
if [ -x ${shQuote(paths.relay)} ] && [ -r ${shQuote(paths.relayConfig)} ]; then
  exec ${shQuote(paths.relay)} ${relayLine(paths, mode, shQuote)} "$@"
fi
# Without its relay or what it reads, as when Novadeck couldn't put them in place: the
# hook takes the agent's input and prints what the agent needs, as Antigravity denies a
# tool otherwise.
cat >/dev/null
case "$1 $2" in
${silentCases(
  (agent, event, text) =>
    `  ${event === "*" ? `"${agent} "*` : `"${agent} ${event}"`}) printf '%s\\n' ${shQuote(text)} ;;`,
).join("\n")}
esac
`

// cmd reads a batch file's blocks reliably only with CRLF line endings.
const crlf = (text: string): string => text.replaceAll("\n", "\r\n")

const cmdLauncher = (paths: ShellPaths, mode: Mode, what: string) =>
  crlf(
    mode === "mcp"
      ? `@echo off
${header("rem", what)}
${cmdQuote(paths.relay)} ${relayLine(paths, mode, cmdQuote)} %*
`
      : `@echo off
${header("rem", what)}
if exist ${cmdQuote(paths.relay)} if exist ${cmdQuote(paths.relayConfig)} (
  ${cmdQuote(paths.relay)} ${relayLine(paths, mode, cmdQuote)} %*
  exit /b 0
)
rem Without its relay or what it reads: the agent's input taken, as it may not write into a
rem closed pipe, and what the agent needs printed, as Antigravity denies a tool otherwise.
findstr "^" >nul 2>nul
${silentCases(
  (agent, event, text) =>
    `if /i "%~1"=="${agent}" ${event === "*" ? "" : `if /i "%~2"=="${event}" `}(echo ${text}&exit /b 0)`,
).join("\n")}
`,
  )

/**
 * How agents start Novadeck's MCP server: on Linux and macOS the launcher the terminal
 * names in NOVADECK_MCP, else this Novadeck's, either replaced by sh and then by the
 * relay; on Windows the relay itself, as a launcher there needs cmd, which stays running
 * beside it, costing each agent several megabytes.
 */
export const mcpStart = (paths: ShellPaths, platform = process.platform): Start =>
  platform === "win32"
    ? { command: paths.relay, args: [...relayArguments(paths).mcp] }
    : terminalsOwn({ command: paths.mcp })

/**
 * `start`, unless the terminal names its own Novadeck's MCP launcher in NOVADECK_MCP.
 * An agent's plugin comes from whichever Novadeck connected it last, while several builds
 * (an installed app and a development one, say) may run side by side; so an agent in a
 * terminal of any of them starts that one's relay, which speaks its runner's protocol
 * and is there for as long as it runs. A variable that names no runnable file, as unset
 * outside Novadeck or left from a build since removed, starts `start`. sh takes `start`
 * as `$0` and its arguments as `$@`, so it never parses them, and the script holds no
 * `${...}`, which Claude Code expands itself.
 */
const terminalsOwn = (start: Start): Start => ({
  command: "/bin/sh",
  args: [
    "-c",
    'if [ -x "$NOVADECK_MCP" ]; then exec "$NOVADECK_MCP"; fi; exec "$0" "$@"',
    start.command,
    ...(start.args ?? []),
  ],
})

const file = (path: string, content: string, mode = 0o600): ShellFile => ({ path, content, mode })

/**
 * Every file for this platform, with the permissions each needs. Plugins start the MCP
 * server as `launchers.mcp` says, and register their hooks as `machine` lets them.
 */
export const shellFiles = (
  paths: ShellPaths,
  platform = process.platform,
  launchers: Launchers = { mcp: mcpStart(paths, platform) },
  machine: Machine = {},
): ShellFile[] => {
  const common = [
    file(paths.relayConfig, `${JSON.stringify(relayConfig, null, 2)}\n`),
    ...shellScripts(paths, header),
    ...agents.flatMap((agent) =>
      harnesses[agent]
        .files(platform, launchers, machine)
        .map((each) => file(join(paths.plugins[agent], each.path), each.content, each.mode)),
    ),
  ]
  // Every harness's shims, which the shells put first on PATH only while one is connected.
  const shims = agents.flatMap((agent) => harnesses[agent].shims?.(platform) ?? [])
  const bin = shims.map((each) => file(join(paths.bin, each.path), each.content, each.mode))
  return platform === "win32"
    ? [
        ...common,
        file(paths.hook, cmdLauncher(paths, "hook", "agent hook launcher")),
        // Agents connected before Novadeck started the relay itself on Windows keep their
        // plugin's copy, which starts the MCP server through cmd and this launcher.
        file(paths.mcp, cmdLauncher(paths, "mcp", "MCP server launcher")),
        ...bin,
      ]
    : [
        ...common,
        file(paths.hook, posixLauncher(paths, "hook", "agent hook launcher"), 0o700),
        file(paths.mcp, posixLauncher(paths, "mcp", "MCP server launcher"), 0o700),
        ...bin,
      ]
}
