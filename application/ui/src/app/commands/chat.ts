import {
  chatAvailable,
  chatModeOn,
  chatDraftOf,
  setChatDraft,
  setChatReply,
  type ChatReplyTo,
  setChatMode,
} from "../../terminals/chat/mode-state"
import { currentContext, currentState } from "../selectors"
import type { CommandContext } from "./context"
import { shellEdits } from "./shell"

// A terminal's agent shows as a conversation or as the terminal's screen. Either way
// typing goes where the person now looks: the chat's box, or the terminal.
export type ChatCommands = {
  // Flips the terminal between its screen and its agent's chat. Does nothing for a
  // terminal no agent runs in, which has no chat.
  readonly toggleChat: (terminalId: string) => void
  // Shows the terminal's screen, as the person asks to answer the agent there.
  readonly showTerminal: (terminalId: string) => void
  // Keeps what the person has typed in the terminal's chat and not sent.
  readonly setChatDraft: (terminalId: string, text: string) => void
  // Adds words to the draft of the terminal in a session, on a line of their own, reading
  // the draft as it is when it changes: whatever the person typed meanwhile stays. They go
  // after it, or before a shell command, so they never become more of its lines.
  readonly appendChatDraft: (context: string, terminalId: string, words: string) => void
  // Clears the draft a prompt was sent from, in the session it was sent in, if the person
  // hasn't changed it since (words added after it, given back or dictated while it went,
  // stay): whether or not the chat is still on screen.
  readonly clearChatDraft: (context: string, terminalId: string, sent: string) => void
  // Sets the question the terminal's draft replies to in a session, or that it is held.
  readonly setChatReply: (context: string, terminalId: string, to: ChatReplyTo | null) => void
}

export const createChatCommands = (ctx: CommandContext): ChatCommands => {
  const { workspace, ui, navigation } = ctx
  const { set } = shellEdits(ctx)
  const show = (terminalId: string, on: boolean): void => {
    const snapshot = workspace.getSnapshot()
    const { roster, view } = currentState(snapshot)
    const terminal = roster.terminals.find((each) => each.id === terminalId)
    if (!terminal || (on && !chatAvailable(terminal))) return
    const context = currentContext(snapshot)
    ui.update((state) => {
      const chat = setChatMode(state.chat, context, terminalId, on)
      return chat === state.chat ? state : { ...state, chat }
    })
    // Where the person now types: the surface or the chat takes keyboard focus.
    navigation.go({ terminal: terminalId })
    set("keyboardFocus", { id: terminalId, view })
  }
  return {
    toggleChat: (terminalId) => {
      const context = currentContext(workspace.getSnapshot())
      show(terminalId, !chatModeOn(ui.getSnapshot().chat, context, terminalId))
    },
    showTerminal: (terminalId) => show(terminalId, false),
    setChatDraft: (terminalId, text) => {
      const context = currentContext(workspace.getSnapshot())
      ui.update((state) => {
        const chatDrafts = setChatDraft(state.chatDrafts, context, terminalId, text)
        return chatDrafts === state.chatDrafts ? state : { ...state, chatDrafts }
      })
    },
    appendChatDraft: (context, terminalId, words) =>
      void ui.update((state) => {
        const draft = chatDraftOf(state.chatDrafts, context, terminalId)
        // After a shell command they would be more of its lines: they go before it, which
        // makes the draft a message to look over before it is sent again.
        const next = !draft.trim()
          ? words
          : draft.trimStart().startsWith("!")
            ? `${words}\n${draft}`
            : `${draft}\n${words}`
        return {
          ...state,
          chatDrafts: setChatDraft(state.chatDrafts, context, terminalId, next),
        }
      }),
    setChatReply: (context, terminalId, to) =>
      void ui.update((state) => {
        const chatReplies = setChatReply(state.chatReplies, context, terminalId, to)
        return chatReplies === state.chatReplies ? state : { ...state, chatReplies }
      }),
    clearChatDraft: (context, terminalId, sent) =>
      void ui.update((state) => {
        const draft = chatDraftOf(state.chatDrafts, context, terminalId)
        const words = sent.trim()
        const begun = draft.trimStart()
        // Words added while it went, given back or dictated, stay without the sent prompt:
        // after it, or on lines before it where it was a shell command.
        const rest = begun.startsWith(words) ? begun.slice(words.length) : null
        const ended = draft.trimEnd()
        const before = ended.endsWith(`\n${words}`) ? ended.slice(0, -words.length - 1) : null
        const left =
          draft.trim() === words
            ? ""
            : rest !== null && /^\s/.test(rest)
              ? rest.trim()
              : before !== null
                ? before.trim()
                : null
        return left === null
          ? state
          : { ...state, chatDrafts: setChatDraft(state.chatDrafts, context, terminalId, left) }
      }),
  }
}
