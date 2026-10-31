import { join } from "node:path"

import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"
import type { Report } from "@novadeck/harness-core/report"

import { box } from "./box.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { claudeHome } from "./home.js"
import { models } from "./models.js"
import { connect, connected, disconnect, files, hook, hookDialect } from "./plugin.js"
import { cmdShim, commands, posixShim } from "./shim.js"
import { followTranscript, transcriptPlans } from "./transcript-watch.js"
import { transcripts } from "./transcripts.js"

// What a hook prints to hand the model `delivery` as context.
const context = (event: string, delivery: string): string =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: delivery } })}\n`

// What its PreToolUse prints to settle a Bash call: `allow` runs it with no dialog and no
// classifier call (probed 2.1.316), `ask` opens its own dialog, whatever else would decide.
const preToolUse = (permissionDecision: "allow" | "ask"): string =>
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason:
        permissionDecision === "allow" ? "Allowed by your grant in Novadeck" : "Asked in Novadeck",
    },
  })}\n`

// What continues a Stop's turn with a delivery the model reads once, by version (probed
// with a fake model, 2026-10-31, #589): a `decision: "block"` reason reaches it once up to
// at least 2.1.233, but twice by 2.1.287, as "Stop hook feedback" and again as a "Stop hook
// blocking error"; a Stop's context continues the turn, read once as a system reminder
// ("Stop hook additional context: …"), only from 2.1.163. Its Stop reports `prompt_id`
// from a version between 2.1.177 and 2.1.233 on, so that says the context works, and
// without it a block reads once.
const stop = (delivery: string, payload?: Report["payload"]): string =>
  payload?.prompt_id !== undefined
    ? context("Stop", delivery)
    : `${JSON.stringify({ decision: "block", reason: delivery })}\n`

// A prompt's context is an attachment beside the prompt, never the prompt itself; a tool
// call's context (PostToolUse, or PostToolUseFailure) is a system reminder next to the
// tool's result, which the model reads on its next request.
const messaging: MessagingProfile = {
  asks: {
    Stop: "stop",
    UserPromptSubmit: "prompt",
    PostToolUse: "tool",
    PostToolUseFailure: "tool",
  },
  // The grants' check, answered at once, and the call auto mode refused, which arms its command.
  permission: {
    event: "PreToolUse",
    reported: false,
    planMode: "plan",
    allow: preToolUse("allow"),
    ask: preToolUse("ask"),
  },
  denied: "PermissionDenied",
  silent: { "*": "" },
  stop,
  prompt: (delivery) => context("UserPromptSubmit", delivery),
  call: (delivery, event) => context(event, delivery),
  reinjectPerCall: false,
  // What a Stop, a prompt and a tool call print is all kept in its transcript,
  // which it sends again on every later call, and a resumed session's too; its
  // `SessionStart` says `compact` once it compacted them away.
  lasting: ["stop", "prompt", "tool"],
  root: "binding",
  silentOnFailure: false,
  // A background agent and shell running, it took a typed prompt (fixture
  // `background-prompt.probe.json`, probed 2026-10-19, 2.1.287).
  promptsInBackground: true,
}

const launch: LaunchProfile = {
  start: ["claude"],
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["claude", line]),
  resume: (session, choice = {}) => ["claude", ...launch.choose(choice), "--resume", session],
  models: () => Promise.resolve(models),
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
  // Claude Code's local install is an alias in the person's rc file, not on PATH.
  fallback: (home) => join(home, ".claude", "local", "claude"),
  home: claudeHome,
  connected,
  connect,
  disconnect,
  hookDialect,
  hook,
  files,
  // Novadeck's shim, through which its shells run Claude Code with its status line.
  shims: (platform) =>
    platform === "win32"
      ? [{ path: "claude.cmd", content: cmdShim }]
      : [{ path: "claude", content: posixShim, mode: 0o700 }],
  // Its commands other than a session: all of them but `attach`, which opens a background
  // session in the terminal, and `ultrareview`, which submits a cloud review. Its print mode
  // runs it on the caller's text, so that is a session's use. The options that take a
  // value, whose next word is no command.
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
  // Its hooks run with its own process's id in their environment.
  pidVariable: "CLAUDE_PID",
  decode,
  dialogs,
  launch,
  messaging,
  box,
  watch: followTranscript,
} satisfies Harness
