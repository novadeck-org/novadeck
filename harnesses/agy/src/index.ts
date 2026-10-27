import { access } from "node:fs/promises"
import { join } from "node:path"

import {
  hookSeconds,
  json,
  mcpServer,
  plugin,
  type MessagingProfile,
  type Harness,
  type Install,
} from "@novadeck/harness-core/harness"
import { hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"

import { box } from "./box.js"
import { decode, shown } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { models } from "./models.js"
import { statusLineLimit, statusLineSettings, trustsFolder } from "./settings.js"
import { transcripts, typedEntry } from "./transcripts.js"

// Antigravity keeps its own state beside other Google tools in ~/.gemini.
const gemini = (home: string) => join(home, ".gemini")
const cli = ({ home: user }: Install) => join(gemini(user), "antigravity-cli")
// Where it keeps the copy of Novadeck's plugin it installed.
const installedPlugin = ({ home }: Install) => join(gemini(home), "config", "plugins", "novadeck")

// Antigravity reads every hook's answer as JSON, even outside Novadeck's shells. It denies
// a tool whose PreToolUse answer gives no decision, `{}` included (probed 2026-10-06 on
// Linux, 1.2.14), so that one's answer is "ask", which leaves the call to the person's
// own policy, here as in Novadeck's shells.
const ask = '{"decision":"ask"}'
// It runs its hooks in cmd on Windows, as `cmd /c "<command>"` (see harness-core's
// `hook-command.ts`).
const hookDialect = (platform: NodeJS.Platform): Dialect => (platform === "win32" ? "cmd" : "sh")

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
  return platform === "win32" ? undefined : ask
}

const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform), {
    agent: "agy",
    event,
    fallback: hookFallback(platform, event),
  })

// A Stop continued with a reason gets it as a lasting system step. A message injected at
// a model call lasts only for that call, so a turn's delivery is injected again on each
// of its later calls. Every other answer is an empty object.
const messaging: MessagingProfile = {
  asks: { Stop: "stop", PreInvocation: "prompt" },
  silent: { PreToolUse: '{"decision":"ask"}\n', "*": "{}\n" },
  stop: (delivery) => `${JSON.stringify({ decision: "continue", reason: delivery })}\n`,
  prompt: (delivery) => `${JSON.stringify({ injectSteps: [{ ephemeralMessage: delivery }] })}\n`,
  reinjectPerCall: true,
  root: "status-line",
  silentOnFailure: false,
  // A subagent running, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 1.2.14).
  promptsInBackground: true,
  // `-i` submits its prompt about 0.9 s after it starts, even while its "Do you trust
  // this folder?" dialog is up, so only in a folder it already trusts.
  initialPrompt: async (line, { install, cwd }) =>
    install && (await trustsFolder(cli(install), cwd)) ? ["agy", "-i", line] : undefined,
  start: ["agy"],
  models: () => Promise.resolve(models),
  choose: ({ model, effort }) => [
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["--effort", effort] : []),
  ],
  // Its hooks name no prompt, but its transcript tells what was typed (a USER_EXPLICIT
  // USER_INPUT step) from what woke it: a subagent's message, a Stop hook's continuation
  // or a notice are SYSTEM_MESSAGE steps, and injected messages EPHEMERAL_MESSAGE ones.
  typedEntry,
}

// A handler for one of its events, with the time it may take.
const handler = (platform: NodeJS.Platform, event: string) => ({
  type: "command",
  command: hook(platform, event),
  timeout: hookSeconds(platform),
})

export const agy = {
  id: "agy",
  // Antigravity installs a plugin folder, which its name must match.
  plugin: join("agy", "novadeck"),
  home: cli,
  connected: (install) =>
    access(join(installedPlugin(install), "plugin.json")).then(
      () => true,
      () => false,
    ),
  // It copies the plugin folder as it installs it (seen 2026-10-11, 1.2.14), so a hook
  // Novadeck renders otherwise, as where cmd prints first, reaches it only installed again.
  installed: { directory: installedPlugin, files: ["hooks.json"] },
  connect: ({ plugin: directory }) => [
    { argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true },
    { argv: ["agy", "plugin", "install", directory] },
  ],
  disconnect: [{ argv: ["agy", "plugin", "uninstall", "novadeck"], optional: true }],
  hookDialect,
  hook,
  // Antigravity runs PreInvocation hooks before each model call, the first time with the
  // conversation's first message, Stop once the turn ends, PreToolUse before every tool,
  // and PostToolUse after the tools that matter here. PreToolUse is answered "ask" at
  // once (never held: a waiting hook hides a confirmation's dialog), so the person's own
  // policy still decides every call; it reports ask_question, which shows a dialog no
  // status line tells, and the call a confirmation is about. Where cmd prints something
  // of its own first (`Machine.cmdPrints`), no answer can be read as JSON, and every tool
  // would run unasked, so PreToolUse goes unregistered: Antigravity's own policy asks, as
  // it does without Novadeck (probed 2026-10-11, 1.2.14, ahead of an "ask" too).
  files: (platform, launchers, machine = {}) => [
    { path: "plugin.json", content: json({ name: plugin.name }) },
    // Its MCP server, which Antigravity takes from the plugin and starts with the
    // terminal's environment.
    {
      path: "mcp_config.json",
      content: json({ mcpServers: { novadeck: mcpServer(launchers) } }),
    },
    {
      path: "hooks.json",
      content: json({
        novadeck: {
          PreInvocation: [handler(platform, "PreInvocation")],
          Stop: [handler(platform, "Stop")],
          // Tool events take matcher groups: after a tool, the ones that write files (one
          // writes artifacts, which names a plan), and the one that asks the person; before every tool.
          ...(!(platform === "win32" && machine.cmdPrints) && {
            PreToolUse: [{ matcher: "*", hooks: [handler(platform, "PreToolUse")] }],
          }),
          // write_file and edit_file from 1.4, write_to_file and replace_file_content before.
          PostToolUse: [
            { matcher: "write_file", hooks: [handler(platform, "PostToolUse")] },
            { matcher: "edit_file", hooks: [handler(platform, "PostToolUse")] },
            { matcher: "write_to_file", hooks: [handler(platform, "PostToolUse")] },
            { matcher: "replace_file_content", hooks: [handler(platform, "PostToolUse")] },
            { matcher: "ask_question", hooks: [handler(platform, "PostToolUse")] },
          ],
        },
      }),
    },
  ],
  // Its status line tells what no hook does: working or idle, a confirmation waiting on
  // the person, and its context and quotas.
  settings: statusLineSettings(cli),
  limited: statusLineLimit(cli),
  resume: (session) => ["agy", "--conversation", session],
  transcripts,
  // Its hooks name no subagents; its status line counts them; see docs/harness-coverage.md.
  // A background subagent's end wakes it with a message saying it went idle.
  wakes: true,
  records: false,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "unsupported",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode,
  dialogs,
  shown,
  messaging,
  box,
} satisfies Harness
