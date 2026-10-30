import type { Conversations } from "@novadeck/core/conversation"
import type { TerminalKey } from "@novadeck/core/types"

import { chatDraftOf, joinDraft, setChatDraft } from "./drafts"
import {
  chatReplyOf,
  replyAnswer,
  sameReply,
  setChatReply,
  type ChatReply,
  type ChatReplyTo,
} from "./replies"
import { chatSendOf, setChatSend } from "./sends"
import type { Chat } from "./state"

// What the chat does with its words, over the chat's own store.
export type ChatCommands = {
  // Keeps what the person has typed in the terminal's chat and not sent. An edit lets go
  // of words held from a reply whose question went: they are the person's message now.
  readonly setChatDraft: (terminalId: string, text: string) => void
  // Adds words to the draft of the terminal in a session, on a line of their own, reading
  // the draft as it is when it changes: whatever the person typed meanwhile stays. They go
  // after it, or before a shell command, so they never become more of its lines.
  readonly appendChatDraft: (context: string, terminalId: string, words: string) => void
  // Sends the draft's words to the terminal's agent: as the answer to the question `to`
  // names, in its own field, or else as a prompt. They leave the draft at once, so the box
  // is free for the next words, whether or not the chat stays on screen, and come back to
  // it, before whatever was typed meanwhile, should they not arrive; the promise then
  // rejects with why. A terminal sends one at a time.
  readonly sendChat: (key: TerminalKey, text: string, to: ChatReply | null) => Promise<void>
  // Sets the question the terminal's draft replies to in a session, or that it is held.
  readonly setChatReply: (context: string, terminalId: string, to: ChatReplyTo | null) => void
}

export const createChatCommands = ({
  chat,
  conversations,
  terminalOpen,
  context: currentContext,
}: {
  readonly chat: Chat
  // The agents' conversations, where the backend reads them.
  readonly conversations: Conversations | undefined
  // Whether the terminal is still in its session.
  readonly terminalOpen: (key: TerminalKey) => boolean
  // The current workspace context: `${projectId}/${workspaceSessionId}`.
  readonly context: () => string
}): ChatCommands => ({
  setChatDraft: (terminalId, text) => {
    const context = currentContext()
    chat.update((state) => {
      const drafts = setChatDraft(state.drafts, context, terminalId, text)
      if (drafts === state.drafts) return state
      const held = chatReplyOf(state.replies, context, terminalId) === "held"
      return {
        ...state,
        drafts,
        ...(held && {
          replies: setChatReply(state.replies, context, terminalId, null),
        }),
      }
    })
  },
  appendChatDraft: (context, terminalId, words) =>
    void chat.update((state) => {
      const draft = chatDraftOf(state.drafts, context, terminalId)
      return {
        ...state,
        drafts: setChatDraft(state.drafts, context, terminalId, joinDraft(draft, words)),
      }
    }),
  sendChat: async (key, text, to) => {
    const context = `${key.projectId}/${key.workspaceSessionId}`
    const { terminalId } = key
    if (!conversations) throw new Error("This backend can't reach the agent.")
    if (chatSendOf(chat.store.getSnapshot().sends, context, terminalId) !== null)
      throw new Error("Your last message is still on its way. Send again once it arrives.")
    // The draft as typed goes back on a failure, not the words as sent, trimmed.
    const draft = chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId) || text
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, terminalId, ""),
      sends: setChatSend(state.sends, context, terminalId, { draft, to }),
    }))
    try {
      await (to
        ? conversations.answer(key, to.request, replyAnswer(to, text))
        : conversations.send(key, text))
    } catch (failure) {
      // Back in the box, before what came meanwhile, for the person to send again; not
      // for a terminal that closed meanwhile, whose draft went with it.
      const open = terminalOpen(key)
      chat.update((state) => ({
        ...state,
        ...(open && {
          drafts: setChatDraft(
            state.drafts,
            context,
            terminalId,
            joinDraft(draft, chatDraftOf(state.drafts, context, terminalId)),
          ),
        }),
        sends: setChatSend(state.sends, context, terminalId, null),
      }))
      throw failure
    }
    chat.update((state) => {
      const replied = to !== null && sameReply(chatReplyOf(state.replies, context, terminalId), to)
      return {
        ...state,
        sends: setChatSend(state.sends, context, terminalId, null),
        ...(replied && {
          replies: setChatReply(state.replies, context, terminalId, null),
        }),
      }
    })
  },
  setChatReply: (context, terminalId, to) =>
    void chat.update((state) => {
      const replies = setChatReply(state.replies, context, terminalId, to)
      return replies === state.replies ? state : { ...state, replies }
    }),
})
