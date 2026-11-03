import { valueOf, withValue, type ByTerminal } from "./by-terminal"
import type { ChatReply } from "./replies"

// Words on their way to a terminal's agent, from the chat's box:
// - `ref`: what names the prompt's receipt in the conversation (`Conversation.prompts`);
// - `draft`: the draft they were sent from, as typed, which goes back in the box should they
//   not go;
// - `text`: the words as sent;
// - `to`: the question they answer, for a reply, which goes at once and shows as its dialog's
//   answer; null for a prompt, which takes its turn in the terminal's queue;
// - `phase`: `queued` while a prompt before it hasn't reached the agent's record yet;
//   `typing` while it goes into the agent's box; `sent` once it went, until its receipt says
//   whether the record has it; `settled` once the record has it, kept only for its words
//   until the conversation holds its item.
export type ChatSend = {
  readonly ref: string
  readonly draft: string
  readonly text: string
  readonly to: ChatReply | null
  readonly phase: "queued" | "typing" | "sent" | "settled"
}

// The words on their way to each terminal's agent, oldest first, by session context and
// terminal id: taken out of the draft as they are sent. A prompt goes once the one before
// it reached the agent's record, so the chat never stacks prompts in the agent's own queue.
export type ChatSends = ByTerminal<readonly ChatSend[]>

export const noChatSends: ChatSends = {}

const none: readonly ChatSend[] = []

export const chatSendsOf = (sends: ChatSends, context: string, id: string): readonly ChatSend[] =>
  valueOf(sends, context, id) ?? none

export const setChatSends = (
  sends: ChatSends,
  context: string,
  id: string,
  list: readonly ChatSend[],
): ChatSends => withValue(sends, context, id, list.length > 0 ? list : undefined)

// The send `ref` names changed by `change`, or dropped where it gives null.
export const withSend = (
  sends: ChatSends,
  context: string,
  id: string,
  ref: string,
  change: (send: ChatSend) => ChatSend | null,
): ChatSends =>
  setChatSends(
    sends,
    context,
    id,
    chatSendsOf(sends, context, id).flatMap((send) => {
      if (send.ref !== ref) return [send]
      const next = change(send)
      return next ? [next] : []
    }),
  )

// The reply on its way to the terminal's agent, if one is.
export const chatReplySendOf = (sends: ChatSends, context: string, id: string): ChatSend | null =>
  chatSendsOf(sends, context, id).find((send) => send.to !== null) ?? null
