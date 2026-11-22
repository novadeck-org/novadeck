import type { MessagingProfile } from "@novadeck/harness-core/harness"

import { typedEntry } from "./transcripts.js"

// What the plugin reads from an answer: a delivery, or nothing (plugin-source.ts).
const deliver = (delivery: string): string => `${JSON.stringify({ deliver: delivery })}\n`

/**
 * How opencode takes part in agents' messaging, through Novadeck's plugin (all probed
 * 2026-11-22, 1.19.6, on Novadeck's fake model): a prompt's delivery is a text part the plugin
 * adds to the person's message, marked synthetic, which the model reads and the TUI doesn't
 * show; a tool call's is added to the result the model reads next; a Stop's starts the next
 * turn, as a synthetic prompt of its own, as opencode takes no answer that keeps a turn going.
 * All three are parts of the session's own messages, kept until a compaction, which the plugin
 * reports.
 */
export const messaging: MessagingProfile = {
  // `/exit`, and its aliases (packages/tui/src/app.tsx, `slashAliases`).
  exitCommands: ["/exit", "/quit", "/q"],
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  silent: { "*": "{}\n" },
  stop: deliver,
  prompt: deliver,
  call: deliver,
  reinjectPerCall: false,
  // A prompt typed while a turn runs goes into the session as it is sent, and its hook with
  // it: the running turn takes it on, and one Stop ends both.
  promptHookOnQueueing: true,
  stopStartsTurn: true,
  root: "binding",
  lasting: ["stop", "prompt", "tool"],
  // Its `session.idle` comes however a turn ended, a failed one too, with the error before it.
  silentOnFailure: false,
  // Escape in its question dialog rejects the question, which ends the turn.
  questionEscape: "interrupts",
  // Nothing outlives its turn: a task's subagent runs inside its call, and bash has no
  // background of its own.
  promptsInBackground: true,
  // It asks its MCP servers for their tools at each step of a turn: its loop resolves them
  // again before every model call (session/prompt.ts, `SessionTools.resolve`; tools.ts).
  toolsAtTurnStart: false,
  typedEntry,
}
