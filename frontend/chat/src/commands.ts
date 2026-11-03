import {
  promptRef,
  type ChatPrompt,
  type Conversation,
  type Conversations,
} from "@novadeck/core/conversation"
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
import {
  chatReplySendOf,
  chatSendsOf,
  setChatSends,
  withSend,
  type ChatSend,
  type ChatSends,
} from "./sends"
import type { Chat, ChatState } from "./state"

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
  // names, in its own field, at once, or else as a prompt, in its turn. They leave the draft
  // at once, so the box is free for the next words, whether or not the chat stays on screen.
  // A prompt goes once the one before it reached the agent's record, where the backend
  // tells (`Conversation.prompts`), else once it went. The promise resolves once the words
  // went, or came back to the box with others' that didn't; it rejects with why they didn't
  // go, when they come back, before whatever was typed meanwhile, with every prompt queued
  // after them. A reply goes one at a time.
  readonly sendChat: (key: TerminalKey, text: string, to: ChatReply | null) => Promise<void>
  // Stops the agent's turn, as Escape in its TUI does. The prompts queued in the chat are
  // never sent after it: they come back to the box after the words the agent handed back,
  // and before what the box holds. Rejects as `Conversations.interrupt` does, the queued
  // prompts back in the box all the same.
  readonly stopChat: (key: TerminalKey) => Promise<void>
  // Sets the question the terminal's draft replies to in a session, or that it is held.
  readonly setChatReply: (context: string, terminalId: string, to: ChatReplyTo | null) => void
}

// How long a prompt sent with its receipt to follow may go without the conversation showing
// that receipt before the chat stops waiting on it, in milliseconds: the backend tells it as
// the prompt's Enter goes, so only a receipt it dropped first is never seen.
export const unseenMs = 15_000

// The session context a terminal's chat state is kept under.
const contextOf = (key: TerminalKey) => `${key.projectId}/${key.workspaceSessionId}`

// The receipt of a prompt, as the conversation shows it now; null where it shows none.
const receiptOf = (conversation: Conversation, ref: string): ChatPrompt | null =>
  conversation.prompts.find((prompt) => prompt.ref === ref) ?? null

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
}): ChatCommands => {
  // How each prompt's promise settles, by ref, while it waits in the queue or goes.
  const settles = new Map<
    string,
    { readonly resolve: () => void; readonly reject: (failure: unknown) => void }
  >()
  // What follows each prompt sent until its receipt says whether the record has it, by ref.
  const watches = new Map<string, () => void>()

  const sendsOf = (key: TerminalKey) =>
    chatSendsOf(chat.store.getSnapshot().sends, contextOf(key), key.terminalId)
  const update = (key: TerminalKey, change: (sends: ChatSends) => ChatSends) =>
    void chat.update((state) => {
      const sends = change(state.sends)
      return sends === state.sends ? state : { ...state, sends }
    })

  // Takes the sends `taken` picks out of the terminal's queue and puts their drafts back in
  // the box, in order, ahead of whatever it holds now. Their promises resolve, but for the
  // one `failed` names, which rejects with why. Nothing goes back for a terminal that closed
  // meanwhile, whose draft went with it.
  const handBack = (
    key: TerminalKey,
    taken: (send: ChatSend) => boolean,
    failed?: readonly [string, unknown],
  ): void => {
    const context = contextOf(key)
    const { terminalId } = key
    const open = terminalOpen(key)
    const back = sendsOf(key).filter(taken)
    chat.update((state: ChatState) => {
      const left = chatSendsOf(state.sends, context, terminalId).filter((send) => !taken(send))
      const words = back.reduce((draft, send) => joinDraft(draft, send.draft), "")
      return {
        ...state,
        ...(open && {
          drafts: setChatDraft(
            state.drafts,
            context,
            terminalId,
            joinDraft(words, chatDraftOf(state.drafts, context, terminalId)),
          ),
        }),
        sends: setChatSends(state.sends, context, terminalId, left),
      }
    })
    for (const send of back) {
      const settle = settles.get(send.ref)
      settles.delete(send.ref)
      if (failed && failed[0] === send.ref) settle?.reject(failed[1])
      else settle?.resolve()
    }
  }

  // The prompt's turn is over: it leaves the queue, and the next one goes. Its words being
  // back in the agent's own box would make the next one a draft there: those queued come
  // back to the chat's box instead.
  const finished = (key: TerminalKey, ref: string, inBox: boolean): void => {
    watches.get(ref)?.()
    watches.delete(ref)
    const was = sendsOf(key).find((send) => send.ref === ref)?.phase
    update(key, (sends) => withSend(sends, contextOf(key), key.terminalId, ref, () => null))
    if (inBox) handBack(key, (send) => send.phase === "queued")
    // One that settled already let the next go.
    else if (was !== "settled") pump(key)
  }

  // Follows a prompt's receipt until it says whether the record has it: it is done once it
  // does, or once it is gone, as when the agent moved to another session.
  const watch = (key: TerminalKey, ref: string): void => {
    const store = conversations!.conversation(key)
    let seen = false
    const session = store.getSnapshot().session
    let settled = false
    const look = (): void => {
      const conversation = store.getSnapshot()
      const receipt = receiptOf(conversation, ref)
      if (receipt) seen = true
      const gone = !receipt && (seen || (session !== null && conversation.session !== session))
      // Settled: the next goes at once, and its words stay to show it until its item
      // arrives, as the receipt carries none.
      if (!gone && receipt?.state === "settled" && receipt.item !== null) {
        if (conversation.items.length > receipt.item) return finished(key, ref, false)
        if (settled) return
        settled = true
        update(key, (sends) =>
          withSend(sends, contextOf(key), key.terminalId, ref, (send) => ({
            ...send,
            phase: "settled",
          })),
        )
        return pump(key)
      }
      if (gone || (receipt && receipt.state !== "pending"))
        finished(key, ref, receipt?.state === "in-box")
    }
    const unsubscribe = store.subscribe(look)
    // A receipt the backend dropped before this window saw it, as one whose session never
    // bound, holds the queue no longer than this.
    const unseen = setTimeout(() => {
      if (!seen && watches.has(ref)) finished(key, ref, false)
    }, unseenMs)
    watches.set(ref, () => {
      clearTimeout(unseen)
      unsubscribe()
    })
    look()
  }

  // Sends the terminal's next queued prompt, once no prompt before it is still on its way:
  // being typed, or sent and not yet in the agent's record.
  const pump = (key: TerminalKey): void => {
    const sends = sendsOf(key)
    const prompts = sends.filter((send) => send.to === null)
    if (prompts.some((send) => send.phase === "typing" || send.phase === "sent")) return
    const next = prompts.find((send) => send.phase === "queued")
    if (!next) return
    const context = contextOf(key)
    const { terminalId } = key
    update(key, (all) =>
      withSend(all, context, terminalId, next.ref, (send) => ({ ...send, phase: "typing" })),
    )
    conversations!.send(key, next.text, { ref: next.ref }).then(
      (result) => {
        const settle = settles.get(next.ref)
        settles.delete(next.ref)
        settle?.resolve()
        if (!sendsOf(key).some((send) => send.ref === next.ref)) return
        if (!result?.tracked) return finished(key, next.ref, false)
        update(key, (all) =>
          withSend(all, context, terminalId, next.ref, (send) => ({ ...send, phase: "sent" })),
        )
        watch(key, next.ref)
      },
      // It didn't go: back in the box with every prompt queued after it, which would only
      // have gone after it.
      (failure: unknown) =>
        handBack(key, (send) => send.ref === next.ref || send.phase === "queued", [
          next.ref,
          failure,
        ]),
    )
  }

  const sendReply = async (key: TerminalKey, text: string, to: ChatReply): Promise<void> => {
    const context = contextOf(key)
    const { terminalId } = key
    if (chatReplySendOf(chat.store.getSnapshot().sends, context, terminalId) !== null)
      throw new Error("Your last answer is still on its way. Send again once it arrives.")
    // The draft as typed goes back on a failure, not the words as sent, trimmed.
    const draft = chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId) || text
    const ref = promptRef()
    chat.update((state) => ({
      ...state,
      drafts: setChatDraft(state.drafts, context, terminalId, ""),
      sends: setChatSends(state.sends, context, terminalId, [
        ...chatSendsOf(state.sends, context, terminalId),
        { ref, draft, text, to, phase: "typing" },
      ]),
    }))
    try {
      await conversations!.answer(key, to.request, replyAnswer(to, text))
    } catch (failure) {
      handBack(key, (send) => send.ref === ref)
      throw failure
    }
    chat.update((state) => {
      const replied = sameReply(chatReplyOf(state.replies, context, terminalId), to)
      return {
        ...state,
        sends: withSend(state.sends, context, terminalId, ref, () => null),
        ...(replied && {
          replies: setChatReply(state.replies, context, terminalId, null),
        }),
      }
    })
  }

  return {
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
      if (!conversations) throw new Error("This backend can't reach the agent.")
      if (to) return await sendReply(key, text, to)
      const context = contextOf(key)
      const { terminalId } = key
      // The draft as typed goes back on a failure, not the words as sent, trimmed.
      const draft = chatDraftOf(chat.store.getSnapshot().drafts, context, terminalId) || text
      const ref = promptRef()
      const sent = new Promise<void>((resolve, reject) => settles.set(ref, { resolve, reject }))
      chat.update((state) => ({
        ...state,
        drafts: setChatDraft(state.drafts, context, terminalId, ""),
        sends: setChatSends(state.sends, context, terminalId, [
          ...chatSendsOf(state.sends, context, terminalId),
          { ref, draft, text, to: null, phase: "queued" },
        ]),
      }))
      pump(key)
      return await sent
    },
    stopChat: async (key) => {
      if (!conversations) throw new Error("This backend can't reach the agent.")
      // Out of the queue at once, so none goes while the turn is being stopped.
      const queued = sendsOf(key).filter((send) => send.phase === "queued")
      const refs = new Set(queued.map((send) => send.ref))
      update(key, (sends) =>
        setChatSends(
          sends,
          contextOf(key),
          key.terminalId,
          chatSendsOf(sends, contextOf(key), key.terminalId).filter((send) => !refs.has(send.ref)),
        ),
      )
      let returned: string | null = null
      try {
        returned = await conversations.interrupt(key)
      } finally {
        // Back in the box after what the agent handed back, which it had before them.
        const context = contextOf(key)
        const { terminalId } = key
        const open = terminalOpen(key)
        const words = queued.reduce((draft, send) => joinDraft(draft, send.draft), returned ?? "")
        if (open && words)
          chat.update((state) => ({
            ...state,
            drafts: setChatDraft(
              state.drafts,
              context,
              terminalId,
              joinDraft(words, chatDraftOf(state.drafts, context, terminalId)),
            ),
          }))
        for (const send of queued) {
          settles.get(send.ref)?.resolve()
          settles.delete(send.ref)
        }
      }
    },
    setChatReply: (context, terminalId, to) =>
      void chat.update((state) => {
        const replies = setChatReply(state.replies, context, terminalId, to)
        return replies === state.replies ? state : { ...state, replies }
      }),
  }
}
