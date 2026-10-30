import { valueOf, withValue, type ByTerminal } from "./by-terminal"
import type { ChatReply } from "./replies"

// Words on their way to a terminal's agent: the draft they were sent from, as typed, which
// goes back in the box should they not arrive, and the question they answer, for a reply.
export type ChatSend = { readonly draft: string; readonly to: ChatReply | null }

// The words on their way to each terminal's agent, by session context and terminal id:
// taken out of the draft as they go. A terminal sends one at a time.
export type ChatSends = ByTerminal<ChatSend>

export const noChatSends: ChatSends = {}

export const chatSendOf = (sends: ChatSends, context: string, id: string): ChatSend | null =>
  valueOf(sends, context, id) ?? null

export const setChatSend = (
  sends: ChatSends,
  context: string,
  id: string,
  send: ChatSend | null,
): ChatSends => withValue(sends, context, id, send ?? undefined)
