import { createStore, type Store } from "@novadeck/core/store"
import type { TerminalMetadata, Workspace } from "@novadeck/core/types"

import { keepTerminals } from "./by-terminal"
import { chatDraftOf, noChatDrafts, setChatDraft, type ChatDrafts } from "./drafts"
import { noChatReplies, settleChatReplies, type ChatReplies } from "./replies"
import { noChatSends, type ChatSends } from "./sends"
import {
  chatKept,
  keepTerminalAnswers,
  noTerminalAnswers,
  setAnsweringInTerminal,
  type TerminalAnswers,
} from "./shown"

// What the app reads of the state, from the package's one door: the selectors, and the
// pure update its tests set a draft with.
export { chatDraftOf, setChatDraft } from "./drafts"
export { chatReplyOf } from "./replies"
export { chatSendOf } from "./sends"
export { chatShown } from "./shown"

// What the chat keeps for the app, a store of its own that the app composes. It starts over
// on reload.
export type ChatState = {
  // What the person typed in a terminal's chat and has not sent.
  readonly drafts: ChatDrafts
  // The question each draft replies to, or that it is held once that question went.
  readonly replies: ChatReplies
  // The words on their way from there to the agent, out of the draft until they arrive.
  readonly sends: ChatSends
  // The terminals showing their screen though the chat view is on, as the person went to
  // answer their agent there.
  readonly answering: TerminalAnswers
}

const initialChat: ChatState = {
  drafts: noChatDrafts,
  replies: noChatReplies,
  sends: noChatSends,
  answering: noTerminalAnswers,
}

export type Chat = {
  readonly store: Store<ChatState>
  // Changes the state by deriving the next; a change that returns the same state notifies
  // nobody.
  readonly update: (change: (state: ChatState) => ChatState) => ChatState
}

export const createChat = (): Chat => {
  const { update, ...store } = createStore(initialChat)
  return { store, update }
}

// The state with the terminal shown as its screen, or the same state where it already is.
const answeringIn = (state: ChatState, context: string, id: string): ChatState => {
  const answering = setAnsweringInTerminal(state.answering, context, id, true)
  return answering === state.answering ? state : { ...state, answering }
}

// The state with every terminal showing its chat again, or the same state where none was
// shown as its screen.
const answeringReset = (state: ChatState): ChatState =>
  state.answering === noTerminalAnswers ? state : { ...state, answering: noTerminalAnswers }

// The state with dictated words added to the terminal's draft, after a space, or directly
// after trailing whitespace; they replace an empty draft. Unlike an edit, they release no
// held reply.
const dictatedInto = (state: ChatState, context: string, id: string, words: string): ChatState => {
  const draft = chatDraftOf(state.drafts, context, id)
  const next = draft.trim() === "" ? words : /\s$/.test(draft) ? draft + words : `${draft} ${words}`
  const drafts = setChatDraft(state.drafts, context, id, next)
  return drafts === state.drafts ? state : { ...state, drafts }
}

// Dictated words go after what the terminal's draft holds.
export const dictateIntoDraft = (
  chat: Chat,
  context: string,
  terminalId: string,
  words: string,
): void => void chat.update((state) => dictatedInto(state, context, terminalId, words))

// Shows the terminal as its screen while the person answers its agent there.
export const answerInTerminal = (chat: Chat, context: string, terminalId: string): void =>
  void chat.update((state) => answeringIn(state, context, terminalId))

// Shows every terminal's chat again, as when the chat view is turned on or off.
export const resetAnswering = (chat: Chat): void => void chat.update(answeringReset)

// Every terminal of every session, by `${context}/${terminalId}`.
const terminalsOf = (workspace: Workspace): Map<string, TerminalMetadata> =>
  new Map(
    workspace.projects.flatMap((project) =>
      project.history.flatMap((session) =>
        session.state.roster.terminals.map(
          (terminal) => [`${project.id}/${session.id}/${terminal.id}`, terminal] as const,
        ),
      ),
    ),
  )

// A terminal shows its chat only while an agent runs in it: once the agent ends, or the
// terminal goes, the screen comes back. A terminal the person went to answer in shows its
// chat again once its agent no longer waits on them, or a later agent starts. What was
// typed in the chat and not sent stays until the terminal goes, for the next agent there.
export const watchChat = (chat: Chat, workspace: Store<Workspace>): (() => void) => {
  let previous = workspace.getSnapshot()
  return workspace.subscribe(() => {
    const snapshot = workspace.getSnapshot()
    if (snapshot.projects === previous.projects) return
    const before = previous
    previous = snapshot
    const held = chat.store.getSnapshot()
    if (
      held.answering === noTerminalAnswers &&
      held.drafts === noChatDrafts &&
      held.replies === noChatReplies
    )
      return
    const terminals = terminalsOf(snapshot)
    const keep = (context: string, id: string): boolean => {
      const terminal = terminals.get(`${context}/${id}`)
      return terminal !== undefined && chatKept(terminal)
    }
    const open = (context: string, id: string): boolean => terminals.has(`${context}/${id}`)
    const earlier = held.answering === noTerminalAnswers ? undefined : terminalsOf(before)
    // Answered: its agent waited on the person a moment ago, and no longer does.
    const answered = (context: string, id: string): boolean => {
      const was = earlier?.get(`${context}/${id}`)
      const now = terminals.get(`${context}/${id}`)
      return (
        was?.state === "running" &&
        was.agent?.attention !== undefined &&
        now?.state === "running" &&
        now.agent?.attention === undefined
      )
    }
    chat.update((state) => {
      const answering = keepTerminalAnswers(
        state.answering,
        (context, id) => keep(context, id) && !answered(context, id),
      )
      const drafts = keepTerminals(state.drafts, open)
      // What a draft replies to, or that it is held, stays as long as the draft: a reply
      // whose question went with its agent comes back held, never as a message, and never
      // replies to a later agent's question.
      const replies = settleChatReplies(
        keepTerminals(state.replies, open),
        drafts,
        (context, id) => open(context, id) && !keep(context, id),
      )
      return answering === state.answering && drafts === state.drafts && replies === state.replies
        ? state
        : { ...state, answering, drafts, replies }
    })
  })
}
