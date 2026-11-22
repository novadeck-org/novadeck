import { access } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookCommand, hookSeconds, type Dialect } from "@novadeck/harness-core/hook-command"

import { pluginSource } from "./plugin-source.js"
import { configPlugin, pluginFile, tuiConfig, tuiPluginFile } from "./shim.js"
import { tuiPluginSource } from "./tui-plugin-source.js"
import { minimum, unknownFrom } from "./version.js"

/**
 * The events Novadeck's plugin reports, by the names its hook command gives them: opencode
 * has none of its own, so these are the plugin's, each from the opencode event or plugin hook
 * plugin-source.ts says.
 */
export const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Continued",
  "Lapsed",
  "PreToolUse",
  "PostToolUse",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PermissionReplied",
  "QuestionRequest",
  "QuestionReplied",
  "Retry",
  "Outdated",
  "SessionLeft",
] as const

/** The file whose presence says Novadeck is connected to opencode (`Harness.marker`). */
export const connectedFile = "connected"

/**
 * The plugin spawns its hook commands with Node's `shell: true`: `/bin/sh -c` on Linux and
 * macOS, and on Windows `cmd.exe /d /s /c`, as opencode's runtime does (Bun follows Node there).
 */
export const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "cmd" : "sh"

/** The plugin's command for its event, in that shell, printing nothing without Novadeck. */
export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), { agent: "opencode", event })

/** Whether Novadeck is connected to opencode: its marker is in the plugin's folder. */
export const connected: Harness["connected"] = (install) =>
  access(join(install.plugin, connectedFile)).then(
    () => true,
    () => false,
  )

/**
 * The plugin's files: its module, beside it a module in a configuration folder that loads it,
 * for a person who set `OPENCODE_CONFIG_CONTENT` themselves, and its MCP server and the
 * folder of agents' worktrees, which it adds to the configuration opencode loaded. opencode
 * takes no hook command, so nothing here is opencode's own configuration: the shim names the
 * plugin for one launch.
 */
export const files: Harness["files"] = (platform, launchers, machine = {}) => [
  {
    path: pluginFile,
    content: pluginSource({
      hooks: Object.fromEntries(events.map((event) => [event, hook(platform, event)])),
      // Its own limit for a hook, which the relay keeps well under.
      hookMs: hookSeconds(platform) * 1000,
      mcp: [launchers.mcp.command, ...(launchers.mcp.args ?? [])],
      worktrees: machine.worktreesRoot ?? null,
      minimum,
      unknownFrom,
    }),
  },
  // Its interface's plugin, which tells a session left for home (`/new`), and the `tui.json` that
  // names it, which the shim hands opencode for the launch (`OPENCODE_TUI_CONFIG`).
  {
    path: tuiPluginFile,
    content: tuiPluginSource({
      hook: hook(platform, "SessionLeft"),
      hookMs: hookSeconds(platform) * 1000,
    }),
  },
  { path: tuiConfig, content: `{"plugin":["./${tuiPluginFile}"]}\n` },
  // opencode loads a configuration folder's `plugins/*.{js,ts}` alone, never `.mjs`
  // (config/plugin.ts, probed 2026-11-22, 1.19.6).
  {
    path: configPlugin,
    content: `// Novadeck's plugin for opencode, loaded from its configuration folder.\nexport { NovadeckPlugin } from "../../${pluginFile}"\n`,
  },
]
