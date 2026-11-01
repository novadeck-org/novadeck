import { access } from "node:fs/promises"
import { join } from "node:path"

import type { Harness, Install, Launchers } from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, manifest } from "@novadeck/harness-core/plugin"

import { geminiHome } from "./home.js"
import { closedAnswer, narrowedAnswers } from "./narrow.js"
import { writers } from "./tools.js"

/** Novadeck's plugin as Antigravity names it, in its commands and its plugins folder. */
export const pluginId = manifest.name

/** Where Antigravity keeps the copy of Novadeck's plugin it installed. */
const installedPlugin = (install: Install): string =>
  join(geminiHome(install), "config", "plugins", pluginId)

/**
 * Antigravity reads every hook's answer as JSON, even outside Novadeck's shells. It denies
 * a tool whose PreToolUse answer gives no decision, `{}` included (probed 2026-10-06 on
 * Linux, 1.2.14), so that one's answer is "ask", which leaves the call to the person's
 * own policy, here as in Novadeck's shells.
 */
export const preToolUseAnswer = '{"decision":"ask"}'

/**
 * Antigravity runs its hooks in cmd on Windows, as `cmd /c "<command>"` (see harness-core's
 * `hook-command.ts`).
 */
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

/**
 * Antigravity's command for its hook `event`, in its shell's dialect, with its fallback. On
 * Windows PreToolUse is the relay alone where `launchers` name it (`launchers.hook`): a
 * narrowed terminal (NOVADECK_NARROW set) needs an answer that is one of Novadeck's three on
 * every path, which the relay prints itself, and a plain terminal gets today's "ask" from
 * it. Without the relay's command line the Windows command stays cmd's, and `files` leaves
 * PreToolUse out.
 */
export const hook = (platform: NodeJS.Platform, event: string, launchers?: Launchers): string => {
  const relay = platform === "win32" && event === "PreToolUse" ? launchers?.hook : undefined
  return hookCommand(hookDialect(platform), {
    agent: "agy",
    event,
    fallback: hookFallback(platform, event),
    ...(relay !== undefined && { direct: [relay.command, ...(relay.args ?? [])] }),
    // In a narrowed terminal its answer is one of Novadeck's three, else closed: a hook that
    // prints nothing lets a granted program run unasked.
    ...(event === "PreToolUse" &&
      platform !== "win32" && {
        narrowed: { answer: closedAnswer, passes: narrowedAnswers },
      }),
  })
}

// A handler for one of its events, with the time it may take.
const handler = (platform: NodeJS.Platform, event: string, launchers?: Launchers) => ({
  type: "command",
  command: hook(platform, event, launchers),
  timeout: hookSeconds(platform),
})

/** Whether Antigravity holds an installed copy of Novadeck's plugin. */
export const connected: Harness["connected"] = (install) =>
  access(join(installedPlugin(install), "plugin.json")).then(
    () => true,
    () => false,
  )

/**
 * It copies the plugin folder as it installs it (seen 2026-10-11, 1.2.14), so a hook
 * Novadeck renders otherwise, as where cmd prints first, reaches it only installed again.
 */
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

/**
 * Antigravity runs PreInvocation hooks before each model call, the first time with the
 * conversation's first message, Stop once the turn ends, PreToolUse before every tool,
 * and PostToolUse after the tools that matter here. PreToolUse is answered "ask" at
 * once (never held: a waiting hook hides a confirmation's dialog), so the person's own
 * policy still decides every call; it reports ask_question, which shows a dialog no
 * status line tells, and the call a confirmation is about. Where cmd prints something
 * of its own first and Novadeck's cmd.exe pass-through is not there to skip it
 * (`Machine.cmdPrints`, set only without the pass-through), no answer can be read as JSON,
 * and every tool would run unasked, so PreToolUse goes unregistered: Antigravity's own policy asks, as
 * it does without Novadeck (probed 2026-10-11, 1.2.14, ahead of an "ask" too). So it does
 * where Windows has no relay command to run alone (`launchers.hook`).
 */
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
        ...((platform !== "win32" || (!machine.cmdPrints && launchers.hook !== undefined)) && {
          PreToolUse: [{ matcher: "*", hooks: [handler(platform, "PreToolUse", launchers)] }],
        }),
        PostToolUse: [...writers, "ask_question"].map((matcher) => ({
          matcher,
          hooks: [handler(platform, "PostToolUse")],
        })),
      },
    }),
  },
]
