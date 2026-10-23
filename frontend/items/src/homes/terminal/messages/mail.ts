import { messagesKey } from "@novadeck/core/companion-bar"
import { companionKeyId, companionKeyOf, type CompanionKey } from "@novadeck/core/items"
import {
  hasMail,
  mailBadge,
  noMail,
  type AgentMessage,
  type MailBadge,
  type MailPeer,
  type MailState,
  type Messages,
  type TerminalMail,
} from "@novadeck/core/messages"
import type { WorkspaceAction } from "@novadeck/core/state"
import type { Store, WorkspaceStore } from "@novadeck/core/store"
import { useSyncExternalStore } from "react"

import { markSeen, seenAt, seenKey, seenStore } from "./seen"

const none: Store<MailState> = { getSnapshot: () => noMail, subscribe: () => () => {} }

// One part of the messages' state, so a component re-renders only when that part changes.
const useMailPart = <T>(messages: Messages | undefined, part: (state: MailState) => T): T => {
  const store = messages?.state ?? none
  return useSyncExternalStore(store.subscribe, () => part(store.getSnapshot()))
}

// What a terminal's tab shows of its messages: the count waiting for its agent.
export const useMailBadge = (
  messages: Messages | undefined,
  key: CompanionKey,
): MailBadge | null => {
  const id = companionKeyId(key)
  const mail = useMailPart(messages, (state) => state.terminals[id])
  const paused = useMailPart(messages, (state) => state.paused)
  return mailBadge(mail, paused)
}

// Whether a terminal has a messages view, which puts the messages on its bar.
export const useHasMail = (messages: Messages | undefined, key: CompanionKey): boolean => {
  const id = companionKeyId(key)
  return useMailPart(messages, (state) => hasMail(state.terminals[id]))
}

// A terminal's messages as its companion pane uses them.
export type MailHandle = {
  readonly mail: TerminalMail | undefined
  readonly paused: boolean
  // A pause or resume is on its way to the backend.
  readonly pending: boolean
  // Why the last pause or resume didn't take.
  readonly error: string | null
  // Whether the terminal has a messages view: it has had messages.
  readonly present: boolean
  readonly badge: MailBadge | null
  readonly pause: (paused: boolean) => void
  // When the person last saw a conversation, by its key, and that they saw it up to `at`.
  readonly seenAt: (conversation: string) => number
  readonly seen: (conversation: string, at: number) => void
}

export const useMail = (messages: Messages | undefined, key: CompanionKey): MailHandle => {
  const id = companionKeyId(key)
  const mail = useMailPart(messages, (state) => state.terminals[id])
  const paused = useMailPart(messages, (state) => state.paused)
  const pending = useMailPart(messages, (state) => state.pending)
  const error = useMailPart(messages, (state) => state.error)
  const seen = seenStore()
  const record = useSyncExternalStore(seen.subscribe, seen.getSnapshot)
  return {
    mail,
    paused,
    pending,
    error,
    present: hasMail(mail),
    badge: mailBadge(mail, paused),
    pause: (next) => messages?.pause(next),
    seenAt: (conversation) => seenAt(record, seenKey(id, conversation)),
    seen: (conversation, at) =>
      seen.update((current) => markSeen(current, seenKey(id, conversation), at)),
  }
}

// What the messages' views know of the session around the terminal: the other terminals
// by handle, and the ways out of the pane, to another terminal and to the Inbox item a
// letter waits in.
export type MailLinks = {
  readonly peer: (handle: string) => MailPeer | undefined
  readonly goTo: (terminalId: string) => void
  readonly answer: (letter: AgentMessage) => void
}

export const noLinks: MailLinks = { peer: () => undefined, goTo: () => {}, answer: () => {} }

// How many messages a terminal's threads hold.
const messageCount = (mail: TerminalMail | undefined): number =>
  (mail?.threads ?? []).reduce((count, thread) => count + thread.messages.length, 0)

// The messages join a terminal's bar when it first has them, after what came before, and
// come back once hidden with the next message, whether or not the terminal is on screen.
// Follows them from here on; returns the stop.
export const followMail = (workspace: WorkspaceStore, messages: Messages): (() => void) => {
  const counts = new Map<string, number>()
  const note = (state: MailState): void => {
    const actions: WorkspaceAction[] = []
    for (const [id, mail] of Object.entries(state.terminals)) {
      const count = messageCount(mail)
      const more = count > (counts.get(id) ?? count)
      counts.set(id, count)
      if (!hasMail(mail)) continue
      // A terminal closed since its mail came takes nothing: the bar's actions pass it by.
      const { terminalId, ...target } = companionKeyOf(id)
      actions.push({ type: "bar/arrive", target, terminalId, key: messagesKey })
      if (more) actions.push({ type: "bar/reopen", target, terminalId, key: messagesKey })
    }
    if (actions.length) workspace.transact(actions)
  }
  note(messages.state.getSnapshot())
  // Heard once the turn is over, as mail may change inside a workspace commit, which can't
  // take this transaction: a closed terminal's mail goes as the backend commits its close.
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
