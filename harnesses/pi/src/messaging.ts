import type { MessagingProfile } from "@novadeck/harness-core/harness"

// What the extension reads from an answer: a delivery, or nothing.
const deliver = (delivery: string): string => `${JSON.stringify({ deliver: delivery })}\n`

/**
 * How pi takes part in agents' messaging, through Novadeck's extension. A skeleton: the values
 * follow design.md (prompt, tool and Stop deliveries) and are to be settled with the probes.
 */
export const messaging: MessagingProfile = {
  exitCommands: ["/quit"],
  asks: { Stop: "stop", UserPromptSubmit: "prompt", PostToolUse: "tool" },
  silent: { "*": "{}\n" },
  stop: deliver,
  prompt: deliver,
  call: deliver,
  reinjectPerCall: false,
  root: "binding",
  lasting: ["stop", "prompt", "tool"],
  silentOnFailure: false,
  // It has no question dialog of its own to answer.
  questionEscape: "interrupts",
  promptsInBackground: true,
  toolsAtTurnStart: false,
}
