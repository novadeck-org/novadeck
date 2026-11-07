import { join } from "node:path"

import { hookTranscript, withLaunch } from "@novadeck/harness-core/decode"
import type { Harness, LaunchProfile, MessagingProfile } from "@novadeck/harness-core/harness"
import { keptFlags, resumeFlags, type KeptFlags } from "@novadeck/harness-core/kept-flags"
import { beside } from "@novadeck/harness-core/paths"
import type { Report } from "@novadeck/harness-core/report"

import { box, slice } from "./box.js"
import { conversation, conversations } from "./conversation.js"
import { decode } from "./decode.js"
import { dialogs } from "./dialogs.js"
import { claudeHome } from "./home.js"
import { models } from "./models.js"
import { connect, connected, disconnect, files, hook, hookDialect } from "./plugin.js"
import { conversational, shapes } from "./shapes.js"
import { cmdShim, commands, many, posixShim, valued } from "./shim.js"
import { followSubagent, followTranscript, transcriptPlans } from "./transcript-watch.js"
import { transcripts } from "./transcripts.js"

// What a hook prints to hand the model `delivery` as context.
const context = (event: string, delivery: string): string =>
  `${JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: delivery } })}\n`

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
  exitCommands: ["/exit", "/quit"],
  asks: {
    Stop: "stop",
    UserPromptSubmit: "prompt",
    PostToolUse: "tool",
    PostToolUseFailure: "tool",
  },
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
  // A request made while Novadeck's server still connects names it so, and its tool
  // search waits for it (seen 2026-11-05, 2.1.316, with that server 3 s slow to start).
  toolsAtTurnStart: false,
}

// What a resume carries over: the permission mode, however it was asked for, the model and
// the effort, which `--resume` doesn't bring back with the session (see `LaunchProfile.kept`).
const kept: KeptFlags = {
  valued: {
    "--model": "--model",
    "--effort": "--effort",
    "--permission-mode": "--permission-mode",
  },
  bare: {
    "--dangerously-skip-permissions": "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions": "--allow-dangerously-skip-permissions",
  },
  takesValue: valued,
  takesMany: many,
  print: ["-p", "--print"],
  sets: (flag) => (flag === "--model" ? "model" : flag === "--effort" ? "effort" : undefined),
}

const launch: LaunchProfile = {
  start: ["claude"],
  // It holds a command-line prompt behind its trust and startup screens.
  initialPrompt: (line) => Promise.resolve(["claude", line]),
  resumed: (claim, { sessionId }) =>
    sessionId === null ? "waiting" : sessionId === claim ? "worked" : "failed",
  resume: (session, choice = {}, carried = []) => [
    "claude",
    ...launch.choose(choice),
    ...resumeFlags(carried, choice, kept),
    "--resume",
    session,
  ],
  kept: (argv) => keptFlags(argv, kept),
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
  conversation,
  conversations,
  home: claudeHome,
  planFolders: (install) => [join(claudeHome(install), "plans")],
  // Its transcripts are `<home>/projects/<project>/<session>.jsonl`.
  planFoldersOf: (transcript) => beside(transcript, "projects", "plans"),
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
    takesValue: valued,
    takesMany: many,
  },
  transcripts: { ...transcripts, shapes, conversational },
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
  decode: (report) => withLaunch(decode(report), report, launch.kept),
  transcriptOf: hookTranscript,
  dialogs,
  commandFields: ["command"],
  launch,
  messaging,
  box,
  slice,
  watch: followTranscript,
  // A subagent's request its person denied, or whose prompt timed out, fires no hook: its own
  // transcript records the call's result.
  watchActor: followSubagent,
} satisfies Harness
