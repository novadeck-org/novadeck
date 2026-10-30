import { readFile } from "node:fs/promises"
import { join } from "node:path"

import type { Harness } from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, manifest, marketplace, mcpVariables } from "@novadeck/harness-core/plugin"

import { codexHome } from "./home.js"

/** Novadeck's plugin as Codex names it: `<plugin>@<marketplace>`. */
export const pluginId = `${manifest.name}@${marketplace.name}`

/** Where Codex keeps its copy of Novadeck's plugin, in its home. */
export const pluginCache = (home: string): string =>
  join(home, "plugins", "cache", marketplace.name, manifest.name)

// The hooks `decode` reads: the session, its turns, and the requests waiting on the person.
const events = [
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Interrupt",
  "SubagentStart",
  "SubagentStop",
  "PermissionRequest",
  "PreToolUse",
  "PostToolUse",
]

// Codex runs an Interrupt hook for 3 seconds at most, and warns at every start of a plugin
// that asks for longer (0.159.3, `normalize_command_hook`), which hides its first screen's
// logo behind the warning's banner. The hook reports an Interrupt within 2 seconds.
const interruptSeconds = 3

/**
 * The shell Codex runs a hook command in: on Windows its shell there, PowerShell (7 where
 * installed), not cmd (probed 2026-10-09, 0.159.3), with -NoProfile.
 */
export const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "powershell" : "sh"

/**
 * The command Novadeck's plugin runs for a hook `event`; without Novadeck it needs nothing
 * printed. Codex asks the person to review its hooks again whenever this text changes, so
 * `hooks.test.ts` pins it.
 */
export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), { agent: "codex", event })

// Its configuration's table for the plugin, enabled.
const enabled = new RegExp(String.raw`\[plugins\."${pluginId}"\][^[]*?\benabled\s*=\s*true`)

/** Whether Codex's configuration has Novadeck's plugin enabled. */
export const connected: Harness["connected"] = async (install) =>
  enabled.test(await readFile(join(codexHome(install), "config.toml"), "utf8").catch(() => ""))

/** Codex's commands that install Novadeck's plugin from its marketplace, afresh. */
export const connect: Harness["connect"] = ({ plugin: directory }) => [
  { argv: ["codex", "plugin", "marketplace", "remove", marketplace.name], optional: true },
  { argv: ["codex", "plugin", "marketplace", "add", directory] },
  { argv: ["codex", "plugin", "add", pluginId] },
]

/** Codex's commands that remove the plugin and its marketplace. */
export const disconnect: Harness["disconnect"] = [
  { argv: ["codex", "plugin", "remove", pluginId], optional: true },
  { argv: ["codex", "plugin", "marketplace", "remove", marketplace.name], optional: true },
]

/** The plugin's marketplace, manifest, MCP server and hooks, as Codex reads them. */
export const files: Harness["files"] = (platform, launchers) => [
  { path: join(".claude-plugin", "marketplace.json"), content: json(marketplace) },
  {
    path: join("novadeck", ".codex-plugin", "plugin.json"),
    content: json({ ...manifest, hooks: "./hooks/hooks.json", mcpServers: "./.mcp.json" }),
  },
  // Its MCP server. Codex starts MCP servers without the terminal's environment, so
  // the variables that name the terminal are passed on by name.
  {
    path: join("novadeck", ".mcp.json"),
    content: json({
      mcpServers: {
        novadeck: { ...launchers.mcp, env_vars: [...mcpVariables] },
      },
    }),
  },
  {
    path: join("novadeck", "hooks", "hooks.json"),
    content: json({
      hooks: Object.fromEntries(
        events.map((event) => [
          event,
          [
            {
              ...(event === "SessionStart" && { matcher: "startup|resume|clear|compact|fork" }),
              // Only the tools that ask the person without a PermissionRequest, and the
              // async question, which asks without waiting. The matcher matches the
              // whole name: `request_user_input` alone doesn't fire for the async one.
              ...(event === "PreToolUse" && {
                matcher: "request_user_input|request_permissions|request_user_input_async",
              }),
              hooks: [
                {
                  type: "command",
                  command: hook(platform, event),
                  timeout: event === "Interrupt" ? interruptSeconds : hookSeconds(platform),
                },
              ],
            },
          ],
        ]),
      ),
    }),
  },
]
