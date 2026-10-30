import type { ChatRequest } from "@novadeck/core/conversation"
import { shellCommand } from "@novadeck/core/conversation/prompt-refusal"

import type { ChatReplyTo } from "./replies"

// What a terminal's chat box does with its words:
// - `message`: sends them as a prompt; `shell` as a shell command, as they start with `!`;
// - `reply`: answers the agent's question in that question's own field;
// - `held`: holds words written as a reply whose question went, until the person edits
//   them, so they never go as a message unread;
// - `waiting`: a reply whose agent's requests aren't read yet, as when the chat comes back
//   on screen, which waits for them before anything goes.
export type ComposerMode = "message" | "shell" | "reply" | "held" | "waiting"

// Whether the question a reply answers is still asked, its dialog the same and taking the
// words in its own field.
const replyOpen = (to: ChatReplyTo | null, requests: readonly ChatRequest[]): boolean =>
  to !== null &&
  to !== "held" &&
  requests.some(
    (request) =>
      request.id === to.request &&
      !request.answered &&
      request.dialog?.type === "questions" &&
      request.dialog.id === to.dialog &&
      request.dialog.chat === "field",
  )

// The box's mode, from its draft, what the draft replies to, the agent's requests, and
// whether those are read yet (`loaded`).
export const composerMode = (
  draft: string,
  replyTo: ChatReplyTo | null,
  requests: readonly ChatRequest[],
  loaded: boolean,
): ComposerMode => {
  if (replyTo !== null && replyTo !== "held") {
    if (!loaded) return "waiting"
    if (replyOpen(replyTo, requests)) return "reply"
  }
  if (replyTo !== null && draft.trim() !== "") return "held"
  return shellCommand(draft) !== undefined ? "shell" : "message"
}
