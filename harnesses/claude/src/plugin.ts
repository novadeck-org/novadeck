import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, manifest, marketplace } from "@novadeck/harness-core/plugin"

import { claudeHome } from "./home.js"

/** Novadeck's plugin as Claude Code names it: the plugin's name at its marketplace's. */
const pluginId = `${manifest.name}@${marketplace.name}`

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

/**
 * Its hooks run in PowerShell on Windows, where its handlers say so (`shell` below). Its
 * status line takes no `shell`, and runs in Git Bash there, as `bash -c "<command>"`
 * (probed 2026-10-23, 2.1.309).
 */
export const hookDialect = (platform: NodeJS.Platform, event?: string): Dialect =>
  platform === "win32" && event !== "StatusLine" ? "powershell" : "sh"

/**
 * Outside Novadeck's shells its hooks print nothing: Claude Code needs no fallback answer.
 * On Windows its status line, run in Git Bash, starts the launcher (a batch file, which
 * Windows starts through `cmd /c` with no `/d`) in a cmd of its own with `/d`, as its
 * PowerShell hooks do: the machine's or the person's AutoRun would otherwise print ahead
 * of the status line. Git Bash's path conversion is off for it, as it reads `/d` as a
 * folder; the launcher is named by its short name, without spaces, and is quoted all the same.
 */
export const hook = (platform: NodeJS.Platform, event: string): string =>
  platform === "win32" && event === "StatusLine"
    ? `[ -n "$NOVADECK_HOOK" ] && MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' "\${COMSPEC:-cmd.exe}" /d /c "$NOVADECK_HOOK" claude ${event} || true`
    : hookCommand(hookDialect(platform, event), { agent: "claude", event })

/** Whether Claude Code's settings list Novadeck's plugin as enabled. */
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

/** Adds Novadeck's marketplace from the plugin's folder and installs the plugin from it. */
export const connect: Harness["connect"] = ({ plugin: directory }) => [
  // A marketplace left from an earlier connection is replaced, not added twice.
  { argv: ["claude", "plugin", "marketplace", "remove", marketplace.name], optional: true },
  { argv: ["claude", "plugin", "marketplace", "add", directory] },
  { argv: ["claude", "plugin", "install", pluginId] },
]

/** Uninstalls the plugin and removes its marketplace, whichever of them is there. */
export const disconnect: Harness["disconnect"] = [
  { argv: ["claude", "plugin", "uninstall", pluginId], optional: true },
  { argv: ["claude", "plugin", "marketplace", "remove", marketplace.name], optional: true },
]

/**
 * The plugin's files: the marketplace and its manifest, its MCP server, its hooks, and the
 * settings Novadeck's shim adds for the status line.
 */
export const files: Harness["files"] = (platform, launchers) => [
  { path: join(".claude-plugin", "marketplace.json"), content: json(marketplace) },
  { path: join("novadeck", ".claude-plugin", "plugin.json"), content: json(manifest) },
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
