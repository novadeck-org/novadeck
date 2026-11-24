import { access } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookCommand, hookSeconds, type Dialect } from "@novadeck/harness-core/hook-command"

import { extensionSource } from "./extension-source.js"
import { minimum, unknownFrom } from "./version.js"

/**
 * The events Novadeck's extension reports, by the names its hook command gives them: pi has none
 * of its own, so these are the extension's, each from the pi event extension-source.ts says.
 */
export const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "PreToolUse",
  "PostToolUse",
  "NestedToolUse",
  "DialogShown",
  "DialogEnded",
] as const

/** The file whose presence says Novadeck is connected to pi (`Harness.marker`). */
export const connectedFile = "connected"

/** The extension's module, in the plugin's folder (`plugins/pi`), which the shim names with `-e`. */
export const extensionFile = "novadeck.mjs"

/** How pi declares Novadeck's tools: `novadeck_send` and so on (tools.ts reads them back). */
export const toolPrefix = "novadeck_"

/** The extension spawns its hook commands with Node's `shell: true`: `sh`, or `cmd` on Windows. */
export const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "cmd" : "sh"

/** The extension's command for its event, in that shell, printing nothing without Novadeck. */
export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), { agent: "pi", event })

/** Whether Novadeck is connected to pi: its marker is in the plugin's folder. */
export const connected: Harness["connected"] = (install) =>
  access(join(install.plugin, connectedFile)).then(
    () => true,
    () => false,
  )

/**
 * The extension's file: its hook commands, Novadeck's MCP server (whose tools it gives pi as its
 * own), the folder of agents' worktrees (whose project trust it answers for one process), and,
 * while the shipping gate is on (`machine.shippingGate`), its refusal of a shell command. pi takes
 * no hook command, so nothing here is pi's own configuration: the shim names it for one launch.
 */
export const files: Harness["files"] = (platform, launchers, machine = {}) => [
  {
    path: extensionFile,
    content: extensionSource({
      hooks: Object.fromEntries(events.map((event) => [event, hook(platform, event)])),
      // Its own limit for a hook, which the relay keeps well under.
      hookMs: hookSeconds(platform) * 1000,
      mcp: [launchers.mcp.command, ...(launchers.mcp.args ?? [])],
      worktrees: machine.worktreesRoot ?? null,
      minimum,
      unknownFrom,
      prefix: toolPrefix,
      // Only while the Experimental shipping gate is on: off, the extension is as it always was.
      ...(machine.shippingGate === true && { gate: true }),
    }),
  },
]
