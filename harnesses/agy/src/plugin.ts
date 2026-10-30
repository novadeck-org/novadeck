import { access } from "node:fs/promises"
import { join } from "node:path"

import type { Harness, Install } from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, manifest } from "@novadeck/harness-core/plugin"

import { geminiHome } from "./home.js"
import { writers } from "./tools.js"

/** Novadeck's plugin as Antigravity names it, in its commands and its plugins folder. */
export const pluginId = manifest.name

/** Where Antigravity keeps the copy of Novadeck's plugin it installed. */
const installedPlugin = (install: Install): string =>
  join(geminiHome(install), "config", "plugins", pluginId)

// Antigravity reads every hook's answer as JSON, even outside Novadeck's shells. It denies
// a tool whose PreToolUse answer gives no decision, `{}` included (probed 2026-10-06 on
// Linux, 1.2.14), so that one's answer is "ask", which leaves the call to the person's
// own policy, here as in Novadeck's shells.
export const preToolUseAnswer = '{"decision":"ask"}'
// It runs its hooks in cmd on Windows, as `cmd /c "<command>"` (see harness-core's
// `hook-command.ts`).
export const hookDialect = (platform: NodeJS.Platform): Dialect =>
  platform === "win32" ? "cmd" : "sh"

// Each event's answer where the launcher is unset, or set but missing or not runnable: one
// Antigravity reads as JSON. On Windows PreToolUse's is none at all: there an answer that
// isn't JSON (an `echo` of "ask" printed it with cmd's escapes kept), or a hook that exits
// non-zero, let the tool run unasked, where no answer, exiting 0, left it to the person's
// policy (probed 2026-10-11, 1.2.14); cmd's command without a fallback gives that. A
// launcher whose path holds `&`, as a profile folder may, breaks every event's line there:
// PreToolUse's still prints nothing and exits 0, so tools still ask, but the other events'
// reports are lost.
const hookFallback = (platform: NodeJS.Platform, event: string): string | undefined => {
  if (event !== "PreToolUse") return "{}"
  return platform === "win32" ? undefined : preToolUseAnswer
}

export const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), {
    agent: "agy",
    event,
    fallback: hookFallback(platform, event),
  })

// A handler for one of its events, with the time it may take.
const handler = (platform: NodeJS.Platform, event: string) => ({
  type: "command",
  command: hook(platform, event),
  timeout: hookSeconds(platform),
})

export const connected: Harness["connected"] = (install) =>
  access(join(installedPlugin(install), "plugin.json")).then(
    () => true,
    () => false,
  )

// It copies the plugin folder as it installs it (seen 2026-10-11, 1.2.14), so a hook
// Novadeck renders otherwise, as where cmd prints first, reaches it only installed again.
export const installed: NonNullable<Harness["installed"]> = {
  directory: installedPlugin,
  files: ["hooks.json"],
}

export const connect: Harness["connect"] = ({ plugin: directory }) => [
  { argv: ["agy", "plugin", "uninstall", pluginId], optional: true },
  { argv: ["agy", "plugin", "install", directory] },
]

export const disconnect: Harness["disconnect"] = [
  { argv: ["agy", "plugin", "uninstall", pluginId], optional: true },
]

// Antigravity runs PreInvocation hooks before each model call, the first time with the
// conversation's first message, Stop once the turn ends, PreToolUse before every tool,
// and PostToolUse after the tools that matter here. PreToolUse is answered "ask" at
// once (never held: a waiting hook hides a confirmation's dialog), so the person's own
// policy still decides every call; it reports ask_question, which shows a dialog no
// status line tells, and the call a confirmation is about. Where cmd prints something
// of its own first (`Machine.cmdPrints`), no answer can be read as JSON, and every tool
// would run unasked, so PreToolUse goes unregistered: Antigravity's own policy asks, as
// it does without Novadeck (probed 2026-10-11, 1.2.14, ahead of an "ask" too).
export const files: Harness["files"] = (platform, launchers, machine = {}) => [
  { path: "plugin.json", content: json({ name: pluginId }) },
  // Its MCP server, which Antigravity takes from the plugin and starts with the
  // terminal's environment.
  {
    path: "mcp_config.json",
    content: json({ mcpServers: { novadeck: launchers.mcp } }),
  },
  {
    path: "hooks.json",
    content: json({
      novadeck: {
        PreInvocation: [handler(platform, "PreInvocation")],
        Stop: [handler(platform, "Stop")],
        // Tool events take matcher groups: before every tool; after a tool, the ones
        // that write files (one writes artifacts, which names a plan), and the one that
        // asks the person.
        ...(!(platform === "win32" && machine.cmdPrints) && {
          PreToolUse: [{ matcher: "*", hooks: [handler(platform, "PreToolUse")] }],
        }),
        PostToolUse: [...writers, "ask_question"].map((matcher) => ({
          matcher,
          hooks: [handler(platform, "PostToolUse")],
        })),
      },
    }),
  },
]
