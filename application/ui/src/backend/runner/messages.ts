import type { TerminalMessages } from "@novadeck/protocol"

import { companionKeyId, type CompanionKey } from "../../model/companion"
import { noMail, type MailState, type Messages, type TerminalMail } from "../../model/messages"
import { createStore } from "../../model/store"

// The runner's messages between agents: each terminal's threads as `messages.watch`
// streams them, and the one pause switch, which every listing reports. A pause the runner
// accepted is so; a release goes on once a listing shows its thread no longer held, as a
// listing may come before or after the runner's answer.

export type MailStreams = {
  readonly watch: (terminalId: string) => AsyncIterableIterator<TerminalMessages, undefined>
  readonly pause: (paused: boolean) => Promise<void>
  readonly release: (thread: string) => Promise<void>
}

export type RunnerMessages = Messages & {
  // The runner has the terminal: follow its messages. Following that ended, as when the
  // runner lost the terminal, starts over; following that runs goes on.
  readonly follow: (key: CompanionKey) => void
  // The terminal is gone: stop following it, and forget its messages.
  readonly unfollow: (key: CompanionKey) => void
  // Stops following every terminal.
  readonly stop: () => void
}

export const mailOf = (listing: TerminalMessages): TerminalMail => ({
  handle: listing.handle,
  agent: listing.delivery !== "unbound",
  threads: listing.threads.map((thread) => ({
    id: thread.id,
    peer: thread.peer,
    hops: thread.hops,
    allowed: thread.allowed,
    held: thread.held,
    messages: thread.messages.map((message) => ({
      id: message.id,
      hop: message.hop,
      from: message.from,
      to: message.to,
      text: message.text,
      sentAt: message.sentAt,
      state: message.state,
      held: message.held,
      deliveredAt: message.deliveredAt,
    })),
  })),
})

// Whether some listing has the thread, and not held.
const goesOn = (current: MailState, thread: string): boolean =>
  Object.values(current.terminals).some((mail) =>
    mail.threads.some((each) => each.id === thread && !each.held),
  )

// Whether some listing has the thread at all.
const listed = (current: MailState, thread: string): boolean =>
  Object.values(current.terminals).some((mail) => mail.threads.some((each) => each.id === thread))

// What the listings now say of releases: a thread shown going on is released once the
// runner accepted it, and any failure it showed is over. With `gone`, as once a terminal's
// listing goes or a release was accepted, a thread no listing has any more can't be shown
// released, so it's let go.
export const reconcile = (current: MailState, gone = false): MailState => {
  const entries = Object.entries(current.releasing)
  const releasing = Object.fromEntries(
    entries.filter(
      ([thread, step]) =>
        !(step === "accepted" && goesOn(current, thread)) && !(gone && !listed(current, thread)),
    ),
  )
  const failed = Object.fromEntries(
    Object.entries(current.failed).filter(([thread]) => !goesOn(current, thread)),
  )
  const same =
    Object.keys(releasing).length === entries.length &&
    Object.keys(failed).length === Object.keys(current.failed).length
  return same ? current : { ...current, releasing, failed }
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : String(error)

export const createRunnerMessages = (
  streams: MailStreams,
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerMessages => {
  const state = createStore<MailState>(noMail)
  const followed = new Map<string, AsyncIterableIterator<TerminalMessages, undefined>>()

  const forget = (id: string): void =>
    void state.update((current) => {
      if (!(id in current.terminals)) return current
      const { [id]: _gone, ...terminals } = current.terminals
      return reconcile({ ...current, terminals }, true)
    })

  const follow = (key: CompanionKey): void => {
    const id = companionKeyId(key)
    if (followed.has(id)) return
    let stream: AsyncIterableIterator<TerminalMessages, undefined>
    try {
      stream = streams.watch(key.terminalId)
    } catch {
      // Messages are extra: a runner that can't follow them leaves the terminal as it is.
      return
    }
    followed.set(id, stream)
    void (async () => {
      try {
        for await (const listing of stream) {
          if (followed.get(id) !== stream) return
          state.update((current) =>
            reconcile({
              ...current,
              paused: listing.paused,
              terminals: { ...current.terminals, [id]: mailOf(listing) },
            }),
          )
        }
      } catch {
        // The runner closed or lost the terminal.
      }
      // Following ended while the terminal is still held: a later `follow` starts over.
      if (followed.get(id) !== stream) return
      followed.delete(id)
      forget(id)
    })()
  }

  const unfollow = (key: CompanionKey): void => {
    const id = companionKeyId(key)
    const stream = followed.get(id)
    followed.delete(id)
    void stream?.return?.()
    forget(id)
  }

  return {
    state,
    pause: (paused) => {
      state.update((current) => ({ ...current, pending: true, error: null }))
      track(streams.pause(paused)).then(
        // The runner took it: it is so, whichever comes first, this or the listings.
        () => state.update((current) => ({ ...current, paused, pending: false })),
        (error: unknown) =>
          state.update((current) => ({
            ...current,
            pending: false,
            error: `Couldn't ${paused ? "pause" : "resume"} messaging: ${reason(error)}`,
          })),
      )
    },
    release: (thread) => {
      state.update((current) => {
        const { [thread]: _before, ...failed } = current.failed
        return { ...current, releasing: { ...current.releasing, [thread]: "asked" }, failed }
      })
      track(streams.release(thread)).then(
        () => {
          state.update((current) =>
            thread in current.releasing
              ? reconcile(
                  { ...current, releasing: { ...current.releasing, [thread]: "accepted" } },
                  true,
                )
              : current,
          )
        },
        (error: unknown) =>
          state.update((current) => ({
            ...current,
            releasing: Object.fromEntries(
              Object.entries(current.releasing).filter(([each]) => each !== thread),
            ),
            // A thread a listing already shows going on was released all the same.
            failed: goesOn(current, thread)
              ? current.failed
              : { ...current.failed, [thread]: `Couldn't release it: ${reason(error)}` },
          })),
      )
    },
    follow,
    unfollow,
    stop: () => {
      for (const [id, stream] of followed) {
        followed.delete(id)
        void stream.return?.()
      }
      state.update((current) => ({ ...current, terminals: {} }))
    },
  }
}
