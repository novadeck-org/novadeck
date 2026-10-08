import type { TerminalKey } from "../../backend/port"
import type { Workspace } from "../../model/types"
import {
  chatDraftOf,
  chatReplyOf,
  chatSendOf,
  joinDraft,
  replyAnswer,
  sameReply,
  setChatDraft,
  setChatReply,
  setAnsweringInTerminal,
  setChatSend,
  type ChatReply,
  type ChatReplyTo,
} from "../../terminals/chat/mode-state"
import { currentContext, currentState } from "../selectors"
import type { CommandContext } from "./context"
import { shellEdits } from "./shell"

// With the chat view on, a terminal's agent shows as a conversation, or as the terminal's
// screen while the person answers it there.
export type ChatCommands = {
  // Shows the terminal's screen, as the person asks to answer the agent there, and types
  // there: its chat comes back once the agent no longer waits on them.
  readonly showTerminal: (terminalId: string) => void
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

// Whether the terminal is still in its session.
const terminalOpen = (snapshot: Workspace, key: TerminalKey): boolean =>
  snapshot.projects
    .find((project) => project.id === key.projectId)
    ?.history.find((session) => session.id === key.workspaceSessionId)
    ?.state.roster.terminals.some((terminal) => terminal.id === key.terminalId) === true

export const createChatCommands = (ctx: CommandContext): ChatCommands => {
  const { workspace, ui, navigation, conversations } = ctx
  const { set } = shellEdits(ctx)
  return {
    showTerminal: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      const { roster, view } = currentState(snapshot)
      if (!roster.terminals.some((each) => each.id === terminalId)) return
      const context = currentContext(snapshot)
      ui.update((state) => {
        const answering = setAnsweringInTerminal(state.answering, context, terminalId, true)
        return answering === state.answering ? state : { ...state, answering }
      })
      // The surface takes keyboard focus, for the person's answer.
      navigation.go({ terminal: terminalId })
      set("keyboardFocus", { id: terminalId, view })
    },
    setChatDraft: (terminalId, text) => {
      const context = currentContext(workspace.getSnapshot())
      ui.update((state) => {
        const chatDrafts = setChatDraft(state.chatDrafts, context, terminalId, text)
        if (chatDrafts === state.chatDrafts) return state
        const held = chatReplyOf(state.chatReplies, context, terminalId) === "held"
        return {
          ...state,
          chatDrafts,
          ...(held && {
            chatReplies: setChatReply(state.chatReplies, context, terminalId, null),
          }),
        }
      })
    },
    appendChatDraft: (context, terminalId, words) =>
      void ui.update((state) => {
        const draft = chatDraftOf(state.chatDrafts, context, terminalId)
        return {
          ...state,
          chatDrafts: setChatDraft(state.chatDrafts, context, terminalId, joinDraft(draft, words)),
        }
      }),
    sendChat: async (key, text, to) => {
      const context = `${key.projectId}/${key.workspaceSessionId}`
      const { terminalId } = key
      if (!conversations) throw new Error("This backend can't reach the agent.")
      if (chatSendOf(ui.getSnapshot().chatSends, context, terminalId) !== null)
        throw new Error("Your last message is still on its way. Send again once it arrives.")
      // The draft as typed goes back on a failure, not the words as sent, trimmed.
      const draft = chatDraftOf(ui.getSnapshot().chatDrafts, context, terminalId) || text
      ui.update((state) => ({
        ...state,
        chatDrafts: setChatDraft(state.chatDrafts, context, terminalId, ""),
        chatSends: setChatSend(state.chatSends, context, terminalId, { draft, to }),
      }))
      try {
        await (to
          ? conversations.answer(key, to.request, replyAnswer(to, text))
          : conversations.send(key, text))
      } catch (failure) {
        // Back in the box, before what came meanwhile, for the person to send again; not
        // for a terminal that closed meanwhile, whose draft went with it.
        const open = terminalOpen(workspace.getSnapshot(), key)
        ui.update((state) => ({
          ...state,
          ...(open && {
            chatDrafts: setChatDraft(
              state.chatDrafts,
              context,
              terminalId,
              joinDraft(draft, chatDraftOf(state.chatDrafts, context, terminalId)),
            ),
          }),
          chatSends: setChatSend(state.chatSends, context, terminalId, null),
        }))
        throw failure
      }
      ui.update((state) => {
        const replied =
          to !== null && sameReply(chatReplyOf(state.chatReplies, context, terminalId), to)
        return {
          ...state,
          chatSends: setChatSend(state.chatSends, context, terminalId, null),
          ...(replied && {
            chatReplies: setChatReply(state.chatReplies, context, terminalId, null),
          }),
        }
      })
    },
    setChatReply: (context, terminalId, to) =>
      void ui.update((state) => {
        const chatReplies = setChatReply(state.chatReplies, context, terminalId, to)
        return chatReplies === state.chatReplies ? state : { ...state, chatReplies }
      }),
  }
}
