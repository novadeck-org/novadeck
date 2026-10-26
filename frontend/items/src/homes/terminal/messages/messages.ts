import { messagesKey } from "@novadeck/core/companion-bar"
import { companionKeyId, companionKeyOf, type CompanionKey } from "@novadeck/core/items"
import {
  hasMessages,
  messageBadge,
  noMessages,
  type AgentMessage,
  type MessageBadge,
  type MessagePeer,
  type MessagesState,
  type Messages,
  type TerminalThreads,
} from "@novadeck/core/messages"
import type { WorkspaceAction } from "@novadeck/core/state"
import type { Store, WorkspaceStore } from "@novadeck/core/store"
import { useSyncExternalStore } from "react"

import { markSeen, seenAt, seenKey, seenStore } from "./seen"

const none: Store<MessagesState> = { getSnapshot: () => noMessages, subscribe: () => () => {} }

// One part of the messages' state, so a component re-renders only when that part changes.
const useMessagesPart = <T>(
  messages: Messages | undefined,
  part: (state: MessagesState) => T,
): T => {
  const store = messages?.state ?? none
  return useSyncExternalStore(store.subscribe, () => part(store.getSnapshot()))
}

// What a terminal's tab shows of its messages: the count waiting for its agent.
export const useMessageBadge = (
  messages: Messages | undefined,
  key: CompanionKey,
): MessageBadge | null => {
  const id = companionKeyId(key)
  const threads = useMessagesPart(messages, (state) => state.terminals[id])
  const paused = useMessagesPart(messages, (state) => state.paused)
  return messageBadge(threads, paused)
}

// Whether a terminal has a messages view, which puts the messages on its bar.
export const useHasMessages = (messages: Messages | undefined, key: CompanionKey): boolean => {
  const id = companionKeyId(key)
  return useMessagesPart(messages, (state) => hasMessages(state.terminals[id]))
}

// A terminal's messages as its companion pane uses them.
export type MessagesHandle = {
  readonly threads: TerminalThreads | undefined
  readonly paused: boolean
  // A pause or resume is on its way to the backend.
  readonly pending: boolean
  // Why the last pause or resume didn't take.
  readonly error: string | null
  // Whether the terminal has a messages view: it has had messages.
  readonly present: boolean
  readonly badge: MessageBadge | null
  readonly pause: (paused: boolean) => void
  // When the person last saw a conversation, by its key, and that they saw it up to `at`.
  readonly seenAt: (conversation: string) => number
  readonly seen: (conversation: string, at: number) => void
}

export const useMessages = (messages: Messages | undefined, key: CompanionKey): MessagesHandle => {
  const id = companionKeyId(key)
  const threads = useMessagesPart(messages, (state) => state.terminals[id])
  const paused = useMessagesPart(messages, (state) => state.paused)
  const pending = useMessagesPart(messages, (state) => state.pending)
  const error = useMessagesPart(messages, (state) => state.error)
  const seen = seenStore()
  const record = useSyncExternalStore(seen.subscribe, seen.getSnapshot)
  return {
    threads,
    paused,
    pending,
    error,
    present: hasMessages(threads),
    badge: messageBadge(threads, paused),
    pause: (next) => messages?.pause(next),
    seenAt: (conversation) => seenAt(record, seenKey(id, conversation)),
    seen: (conversation, at) =>
      seen.update((current) => markSeen(current, seenKey(id, conversation), at)),
  }
}

// What the messages' views know of the session around the terminal: the other terminals
// by handle, and the ways out of the pane, to another terminal and to the Inbox item a
// letter waits in.
// The peers are a store, which only the views that draw them subscribe to, so a terminal
// whose pane is shut never renders again as an agent starts or stops working.
export type MessageLinks = {
  readonly peers: Store<Readonly<Record<string, MessagePeer>>>
  readonly goTo: (terminalId: string) => void
  readonly answer: (letter: AgentMessage) => void
}

const nobody: Readonly<Record<string, MessagePeer>> = {}

export const noLinks: MessageLinks = {
  peers: { getSnapshot: () => nobody, subscribe: () => () => {} },
  goTo: () => {},
  answer: () => {},
}

// The peers as a view draws them, by handle.
export const usePeers = (links: MessageLinks): Readonly<Record<string, MessagePeer>> =>
  useSyncExternalStore(links.peers.subscribe, links.peers.getSnapshot)

// How many messages a terminal's threads hold.
const messageCount = (threads: TerminalThreads | undefined): number =>
  (threads?.threads ?? []).reduce((count, thread) => count + thread.messages.length, 0)

// The messages join a terminal's bar when it first has them, after what came before, and
// come back once hidden with the next message, whether or not the terminal is on screen.
// Follows them from here on; returns the stop.
export const followMessages = (workspace: WorkspaceStore, messages: Messages): (() => void) => {
  const counts = new Map<string, number>()
  const note = (state: MessagesState): void => {
    const actions: WorkspaceAction[] = []
    for (const [id, threads] of Object.entries(state.terminals)) {
      const count = messageCount(threads)
      const more = count > (counts.get(id) ?? count)
      counts.set(id, count)
      if (!hasMessages(threads)) continue
      // A terminal closed since its messages came takes nothing: the bar's actions pass it by.
      const { terminalId, ...target } = companionKeyOf(id)
      actions.push({ type: "bar/arrive", target, terminalId, key: messagesKey })
      if (more) actions.push({ type: "bar/reopen", target, terminalId, key: messagesKey })
    }
    if (actions.length) workspace.transact(actions)
  }
  note(messages.state.getSnapshot())
  // Heard once the turn is over, as messages may change inside a workspace commit, which can't
  // take this transaction: a closed terminal's messages goes as the backend commits its close.
  // What changed meanwhile is read then, once.
  let heard = false
  let following = true
  const stop = messages.state.subscribe(() => {
    if (heard) return
    heard = true
    queueMicrotask(() => {
      heard = false
      if (following) note(messages.state.getSnapshot())
    })
  })
  return () => {
    following = false
    stop()
  }
}
