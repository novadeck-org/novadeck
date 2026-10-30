import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { followLines } from "@novadeck/harness-core/follow"
import {
  efforts,
  type MessagingProfile,
  type Harness,
  type Install,
} from "@novadeck/harness-core/harness"
import { hookSeconds, hookCommand, type Dialect } from "@novadeck/harness-core/hook-command"
import { json, marketplace, manifest } from "@novadeck/harness-core/plugin"

import { box } from "./box.js"
import { decode, transcriptPlans } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { cmdShim, commands, posixShim } from "./shim.js"
import { transcriptEvents, type Calls } from "./transcript.js"
import { transcripts } from "./transcripts.js"

const id = "novadeck@novadeck"

/** Claude Code's configuration folder, which also keeps its plans in `plans`. */
export const configFolder = ({ env, home: user }: Pick<Install, "env" | "home">): string =>
  env.CLAUDE_CONFIG_DIR || join(user, ".claude")

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
const hookDialect = (platform: NodeJS.Platform, event?: string): Dialect =>
  platform === "win32" && event !== "StatusLine" ? "powershell" : "sh"

// Without Novadeck it needs nothing printed.
const hook = (platform: NodeJS.Platform, event: string): string =>
  hookCommand(hookDialect(platform, event), { agent: "claude", event })

const claudeModels = ["opus", "sonnet", "haiku", "fable"].map((alias) => ({ id: alias, efforts }))

// A Stop's reason continues the turn, and reaches the model as the Stop hook's feedback;
// a prompt's context is an attachment beside the prompt, never the prompt itself; a tool
// call's context (PostToolUse, or PostToolUseFailure) is a system reminder next to the
// tool's result, which the model reads on its next request.
const messaging: MessagingProfile = {
  asks: {
    Stop: "stop",
    UserPromptSubmit: "prompt",
    PostToolUse: "tool",
    PostToolUseFailure: "tool",
  },
  silent: { "*": "" },
  stop: (delivery) => `${JSON.stringify({ decision: "block", reason: delivery })}\n`,
  prompt: (delivery) =>
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: delivery },
    })}\n`,
  call: (delivery, event) =>
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: delivery } })}\n`,
  reinjectPerCall: false,
  root: "binding",
  silentOnFailure: false,
  // A background agent and shell running, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 2.1.287).
  promptsInBackground: true,
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["claude", line]),
  start: ["claude"],
  // Its aliases, which it resolves to the latest model of each family.
  models: () => Promise.resolve(claudeModels),
  choose: ({ model, effort }) => [
    ...(model !== undefined ? ["--model", model] : []),
    ...(effort !== undefined ? ["--effort", effort] : []),
  ],
}

// Its commands that start work for an agent though they open no session here.
const sessionCommands = new Set(["attach", "ultrareview"])

export const claude = {
  id: "claude",
  plugin: "claude",
  // Claude Code's local install is an alias in the user's rc file, not on PATH.
  fallback: (user) => join(user, ".claude", "local", "claude"),
  home: configFolder,
  connected: async (install) => {
    try {
      const settings = JSON.parse(
        await readFile(join(configFolder(install), "settings.json"), "utf8"),
      ) as {
        enabledPlugins?: Record<string, unknown>
      }
      return settings.enabledPlugins?.[id] === true
    } catch {
      return false
    }
  },
  connect: ({ plugin: directory }) => [
    // A marketplace left from an earlier connection is replaced, not added twice.
    { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
    { argv: ["claude", "plugin", "marketplace", "add", directory] },
    { argv: ["claude", "plugin", "install", id] },
  ],
  disconnect: [
    { argv: ["claude", "plugin", "uninstall", id], optional: true },
    { argv: ["claude", "plugin", "marketplace", "remove", "novadeck"], optional: true },
  ],
  hookDialect,
  hook,
  files: (platform, launchers) => [
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
  ],
  // The status line Novadeck's shim adds, where its shells run Claude Code.
  shims: (platform) =>
    platform === "win32"
      ? [{ path: "claude.cmd", content: cmdShim }]
      : [{ path: "claude", content: posixShim, mode: 0o700 }],
  // Its commands other than a session, but `attach`, which opens a background session in
  // the terminal, and `ultrareview`, which submits a cloud review; its print mode runs it
  // on the caller's text, so it is none. Its options
  // that take a value, which the words after them are not commands for.
  nonSession: {
    commands: commands.filter((command) => !sessionCommands.has(command)),
    flags: ["-h", "--help", "-v", "--version"],
    print: ["-p", "--print"],
    takesValue: [
      "--add-dir",
      "--agent",
      "--agents",
      "--allowedTools",
      "--allowed-tools",
      "--append-system-prompt",
      "--autocompact",
      "--betas",
      "--debug-file",
      "--disallowedTools",
      "--disallowed-tools",
      "--effort",
      "--environment",
      "--fallback-model",
      "--file",
      "--input-format",
      "--json-schema",
      "--max-budget-usd",
      "--mcp-config",
      "--model",
      "-n",
      "--name",
      "--output-format",
      "--permission-mode",
      "--permission-prompts",
      "--plugin-dir",
      "--plugin-url",
      "--session-id",
      "--setting-sources",
      "--settings",
      "--system-prompt",
      "--tools",
    ],
  },
  resume: (session, choice = {}) => ["claude", ...messaging.choose(choice), "--resume", session],
  transcripts,
  plans: transcriptPlans,
  // Its hooks, transcript and status line; see docs/harness-coverage.md.
  // A background subagent's or command's end starts a turn with a task notification.
  wakes: true,
  records: true,
  coverage: {
    session: "partial",
    activity: "partial",
    attention: "partial",
    actors: "partial",
    transcripts: "partial",
    planning: "partial",
    usage: "unsupported",
    limits: "partial",
    context: "partial",
  },
  decode,
  dialogs,
  messaging,
  box,
  // The transcript records what no hook reports: an interrupted turn, and a request a
  // timed-out prompt denied.
  watch: (run, signal, emit) => {
    const calls: Calls = new Map()
    return followLines(run.transcript, signal, (line) => {
      for (const event of transcriptEvents(line, run, calls)) emit(event)
    })
  },
} satisfies Harness
