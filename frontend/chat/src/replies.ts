import type { ChatAnswer } from "@novadeck/core/conversation"
import { chatAnswer, oneLine } from "@novadeck/core/conversation/picks"

import { valueOf, withValue, type ByTerminal } from "./by-terminal"
import { chatDraftOf, type ChatDrafts } from "./drafts"

// The question a terminal's chat box replies to, by session context and terminal id: a
// request's dialog while the person replies to it there, or "held" once it went with the
// words still in the box, which then wait for the person's edit. Kept beside the draft, so
// it outlives the chat leaving the screen as the draft does; none is not kept.
export type ChatReply = { readonly request: string; readonly dialog: string }
export type ChatReplyTo = ChatReply | "held"

// The answer a reply sends: its words for the question's own field, which takes one line.
export const replyAnswer = (to: ChatReply, text: string): ChatAnswer =>
  chatAnswer(to.dialog, oneLine(text))

export type ChatReplies = ByTerminal<ChatReplyTo>

export const noChatReplies: ChatReplies = {}

export const chatReplyOf = (
  replies: ChatReplies,
  context: string,
  id: string,
): ChatReplyTo | null => valueOf(replies, context, id) ?? null

export const sameReply = (
  a: ChatReplyTo | null | undefined,
  b: ChatReplyTo | null | undefined,
): boolean =>
  (a ?? null) === (b ?? null) ||
  (a != null &&
    b != null &&
    a !== "held" &&
    b !== "held" &&
    a.request === b.request &&
    a.dialog === b.dialog)

export const setChatReply = (
  replies: ChatReplies,
  context: string,
  id: string,
  to: ChatReplyTo | null,
): ChatReplies => withValue(replies, context, id, to ?? undefined, sameReply)

// Settles what a terminal's draft replies to once its agent ended, the terminal still
// there: a question asked by that agent is gone for good, so words written for it are held
// for the person's edit, and with no words the reply goes. A held reply stays held.
export const settleChatReplies = (
  replies: ChatReplies,
  drafts: ChatDrafts,
  ended: (context: string, id: string) => boolean,
): ChatReplies => {
  let next = replies
  for (const [context, ids] of Object.entries(replies))
    for (const [id, to] of Object.entries(ids))
      if (to !== "held" && ended(context, id))
        next = setChatReply(
          next,
          context,
          id,
          chatDraftOf(drafts, context, id).trim() === "" ? null : "held",
        )
  return next
}
