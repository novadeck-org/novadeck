import type { MessagingProfile } from "@novadeck/harness-core/harness"

// What the extension reads from an answer: a delivery, or nothing (extension-source.ts).
const deliver = (delivery: string): string => `${JSON.stringify({ deliver: delivery })}\n`

/**
 * How pi takes part in agents' messaging, through Novadeck's extension (all probed 2026-11-24,
 * 1.6.0, on a fake model): a prompt's delivery is a message of Novadeck's (`custom_message`,
 * `customType` "novadeck") that goes in right after the person's prompt, in the same model call;
 * a tool call's is steered in after that call's results, before the next model call; a Stop's
 * goes on in the same run (pi's `agent_before_settle` asks for one more model call), as Claude
 * Code's Stop hook does. All three are messages of the session, kept until a compaction, which the
 * extension reports. An idle agent is rung by the doorbell, typed into its box, as every harness is.
 */
export const messaging: MessagingProfile = {
  // Its `/quit` (Ctrl+C twice or Ctrl+D exit it as keys).
  exitCommands: ["/quit"],
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  silent: { "*": "{}\n" },
  stop: deliver,
  prompt: deliver,
  call: deliver,
  reinjectPerCall: false,
  // A prompt given while a run goes on runs its prompt hook as pi queues it (its `input` event),
  // and the person may take it back out of the queue (Alt+Up), as an abort does (docs/usage.md).
  promptHookOnQueueing: true,
  root: "binding",
  lasting: ["stop", "prompt", "tool"],
  // Its Stop comes however a run ended, a failed one too, with the error.
  silentOnFailure: false,
  // It has no question dialog of its own; a person's extension's goes with Escape, and its run
  // goes on with whatever that extension makes of it.
  questionEscape: "skips",
  // Nothing outlives its run: no subagents and no background shells of its own.
  promptsInBackground: true,
  // The extension gives pi Novadeck's tools as each session starts, before its prompt takes one.
  toolsAtTurnStart: false,
}
