import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, marketplace, plugin } from "@novadeck/harness-core/plugin"

import { claudeHome } from "./home.js"

/** Novadeck's plugin as Claude Code names it, and the marketplace it comes from. */
const pluginId = "novadeck@novadeck"
const marketplaceName = "novadeck"

// The hooks `decode` reads: the session, its turns, and the requests waiting on the person.
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "Elicitation",
  "ElicitationResult",
  "PostToolUse",
  "PostToolUseFailure",
]

// Its hooks run in PowerShell on Windows, where its handlers say so (`shell` below). Its
// status line takes no `shell`, and runs in Git Bash there, as `bash -c "<command>"`
// (probed 2026-10-23, 2.1.309).
export const hookDialect = (platform: NodeJS.Platform, event?: string): Dialect =>
  platform === "win32" && event !== "StatusLine" ? "powershell" : "sh"

// Outside Novadeck's shells its hooks print nothing: Claude Code needs no fallback answer.
export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform, event), { agent: "claude", event })

export const connected: Harness["connected"] = async (install) => {
  try {
    const settings = JSON.parse(
      await readFile(join(claudeHome(install), "settings.json"), "utf8"),
    ) as {
      enabledPlugins?: Record<string, unknown>
    }
    return settings.enabledPlugins?.[pluginId] === true
  } catch {
    return false
  }
}

export const connect: Harness["connect"] = ({ plugin: directory }) => [
  // A marketplace left from an earlier connection is replaced, not added twice.
  { argv: ["claude", "plugin", "marketplace", "remove", marketplaceName], optional: true },
  { argv: ["claude", "plugin", "marketplace", "add", directory] },
  { argv: ["claude", "plugin", "install", pluginId] },
]

export const disconnect: Harness["disconnect"] = [
  { argv: ["claude", "plugin", "uninstall", pluginId], optional: true },
  { argv: ["claude", "plugin", "marketplace", "remove", marketplaceName], optional: true },
]

export const files: Harness["files"] = (platform, launchers) => [
  { path: join(".claude-plugin", "marketplace.json"), content: marketplace },
  { path: join("novadeck", ".claude-plugin", "plugin.json"), content: json(plugin) },
  // Its MCP server, which Claude Code finds at the plugin's root and starts with the
  // terminal's environment.
  {
    path: join("novadeck", ".mcp.json"),
    content: json({ mcpServers: { novadeck: launchers.mcp } }),
  },
  {
    path: join("novadeck", "hooks", "hooks.json"),
    content: json({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [
            {
              hooks: [
                {
                  type: "command",
                  command: hook(platform, event),
                  timeout: hookSeconds(platform),
                  ...(platform === "win32" && { shell: "powershell" }),
                },
              ],
            },
          ],
        ]),
      ),
    }),
  },
  // The settings Novadeck's shim adds: its hook as the status line, which passes on the
  // person's own (see the runner's shell/hook.ts).
  {
    path: "statusline.json",
    content: json({
      statusLine: { type: "command", command: hook(platform, "StatusLine"), padding: 0 },
    }),
  },
]
