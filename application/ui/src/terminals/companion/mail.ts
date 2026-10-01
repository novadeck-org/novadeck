import { useSyncExternalStore } from "react"

import { companionKeyId, type CompanionKey } from "../../model/companion"
import {
  hasMail,
  mailBadge,
  noMail,
  type MailBadge,
  type MailState,
  type Messages,
  type TerminalMail,
} from "../../model/messages"
import type { Store } from "../../model/store"

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

// A terminal's messages as its companion pane uses them.
export type MailHandle = {
  readonly mail: TerminalMail | undefined
  readonly paused: boolean
  // A pause or resume is on its way to the backend.
  readonly pending: boolean
  // Why the last pause or resume didn't take.
  readonly error: string | null
  readonly releasing: readonly string[]
  // Why a thread's last release didn't take, by thread.
  readonly failed: Readonly<Record<string, string>>
  // Whether the terminal has a messages view: an agent is there, or it had messages.
  readonly present: boolean
  readonly badge: MailBadge | null
  readonly pause: (paused: boolean) => void
  readonly release: (thread: string) => void
}

export const useMail = (messages: Messages | undefined, key: CompanionKey): MailHandle => {
  const id = companionKeyId(key)
  const mail = useMailPart(messages, (state) => state.terminals[id])
  const paused = useMailPart(messages, (state) => state.paused)
  const pending = useMailPart(messages, (state) => state.pending)
  const releases = useMailPart(messages, (state) => state.releasing)
  const error = useMailPart(messages, (state) => state.error)
  const failed = useMailPart(messages, (state) => state.failed)
  return {
    mail,
    paused,
    pending,
    releasing: Object.keys(releases),
    error,
    failed,
    present: hasMail(mail),
    badge: mailBadge(mail, paused),
    pause: (next) => messages?.pause(next),
    release: (thread) => messages?.release(thread),
  }
}
