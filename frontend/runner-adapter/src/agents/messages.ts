import {
  noMessages,
  type MessageParty as CoreParty,
  type MessagesState,
  type Messages,
  type TerminalThreads,
} from "@novadeck/core/messages"
import { createStore } from "@novadeck/core/store"
import { type TerminalKey, terminalKeyPath } from "@novadeck/core/types"
import {
  listedDeliveriesMost,
  listedRingsMost,
  type MessageParty,
  type TerminalMessages,
  type TerminalRings,
} from "@novadeck/protocol"

import { reasonOf } from "../errors"
import { reportCaught } from "../streams"

// The runner's messages between agents: each terminal's threads as `messages.watch`
// streams them, and the one pause switch, which every listing reports. A pause the runner
// accepted is so; a release goes on once a listing shows its thread no longer held, as a
// listing may come before or after the runner's answer.

export type MessageStreams = {
  readonly watch: (terminalId: string) => AsyncIterableIterator<TerminalMessages, undefined>
  // What a terminal's rings and deliveries say after the sequence the caller has.
  readonly rings: (terminalId: string, since: number) => Promise<TerminalRings>
  readonly pause: (paused: boolean) => Promise<void>
  readonly release: (thread: string) => Promise<void>
  readonly stop: (thread: string) => Promise<void>
}

export type RunnerMessages = Messages & {
  // The runner has the terminal: follow its messages. Following that ended, as when the
  // runner lost the terminal, starts over; following that runs goes on.
  readonly follow: (key: TerminalKey) => void
  // The terminal is gone: stop following it, and forget its messages.
  readonly unfollow: (key: TerminalKey) => void
  // Stops following every terminal.
  readonly end: () => void
}

const partyOf = (party: MessageParty): CoreParty =>
  party.kind === "person"
    ? { kind: "person" }
    : { kind: "agent", terminalId: party.terminalId, handle: party.handle, agent: party.agent }

export const messagesOf = (listing: TerminalMessages): TerminalThreads => ({
  terminalId: listing.terminalId,
  handle: listing.handle,
  agent: listing.delivery !== "unbound",
  waits: listing.waits,
  waitsSince: listing.waitsSince,
  ringing: listing.delivery === "ringing",
  notices: listing.notices,
  ...(listing.ringSeq !== undefined && { ringSeq: listing.ringSeq }),
  threads: listing.threads.map((thread) => ({
    id: thread.id,
    peer: partyOf(thread.peer),
    hops: thread.hops,
    idle: thread.idle,
    held: thread.held,
    heldFor: thread.heldFor,
    messages: thread.messages.map((message) => ({
      id: message.id,
      ...(message.inbox ? { inbox: message.inbox } : {}),
      ...(message.inboxState ? { inboxState: message.inboxState } : {}),
      hop: message.hop,
      from: partyOf(message.from),
      to: partyOf(message.to),
      text: message.text,
      sentAt: message.sentAt,
      state: message.state,
      held: message.held,
      deliveredAt: message.deliveredAt,
    })),
  })),
})

// Whether some listing has the thread, and not held.
const goesOn = (current: MessagesState, thread: string): boolean =>
  Object.values(current.terminals).some((terminalMessages) =>
    terminalMessages.threads.some((each) => each.id === thread && !each.held),
  )

// Whether some listing has the thread at all.
const listed = (current: MessagesState, thread: string): boolean =>
  Object.values(current.terminals).some((terminalMessages) =>
    terminalMessages.threads.some((each) => each.id === thread),
  )

// What the listings now say of releases: a thread shown going on is released once the
// runner accepted it, and any failure it showed is over. With `gone`, as once a terminal's
// listing goes or a release was accepted, a thread no listing has any more can't be shown
// released, so it's let go.
export const reconcile = (current: MessagesState, gone = false): MessagesState => {
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

export const createRunnerMessages = (
  streams: MessageStreams,
  // Keeps a call the backend waits for before it stops, as its other calls are.
  track: <T>(work: Promise<T>) => Promise<T> = (work) => work,
): RunnerMessages => {
  const state = createStore<MessagesState>(noMessages)
  const followed = new Map<string, AsyncIterableIterator<TerminalMessages, undefined>>()

  const forget = (id: string): void =>
    void state.update((current) => {
      if (!(id in current.terminals)) return current
      const { [id]: _gone, ...terminals } = current.terminals
      return reconcile({ ...current, terminals }, true)
    })

  const follow = (key: TerminalKey): void => {
    const id = terminalKeyPath(key)
    if (followed.has(id)) return
    let stream: AsyncIterableIterator<TerminalMessages, undefined>
    try {
      stream = streams.watch(key.terminalId)
    } catch {
      // Messages are extra: a runner that can't follow them leaves the terminal as it is.
      return
    }
    followed.set(id, stream)
    // The rings and deliveries are not in the listing, which would send them whole on every
    // change: they only grow at their end, so each listing that says the sequence moved has what
    // came after the last one held asked for, and appended.
    let have = 0
    let pulling = false
    const pull = async (latest: () => number): Promise<void> => {
      if (pulling) return
      pulling = true
      try {
        while (latest() > have && followed.get(id) === stream) {
          // eslint-disable-next-line no-await-in-loop -- One request at a time, from the last held.
          const more = await streams.rings(key.terminalId, have)
          if (followed.get(id) !== stream) return
          have = more.seq
          state.update((current) => {
            const terminal = current.terminals[id]
            if (!terminal) return current
            const rings = [...(terminal.rings ?? []), ...more.rings].slice(-listedRingsMost)
            const deliveries = [...(terminal.deliveries ?? []), ...more.deliveries].slice(
              -listedDeliveriesMost,
            )
            return {
              ...current,
              terminals: { ...current.terminals, [id]: { ...terminal, rings, deliveries } },
            }
          })
        }
      } catch {
        // Rows stay as the harness drew them; the next listing that moves the sequence asks again.
      } finally {
        pulling = false
      }
    }
    let ringSeq = 0
    void (async () => {
      try {
        for await (const listing of stream) {
          if (followed.get(id) !== stream) return
          ringSeq = listing.ringSeq ?? 0
          // A runner that started afresh counts from the start again.
          const restarted = ringSeq < have
          if (restarted) have = 0
          // A reader that throws is reported; the next listing reaches the state as usual.
          try {
            state.update((current) => {
              const before = current.terminals[id]
              const next = messagesOf(listing)
              const held = restarted ? undefined : before
              return reconcile({
                ...current,
                paused: listing.paused,
                terminals: {
                  ...current.terminals,
                  [id]: {
                    ...next,
                    ...(held?.rings && { rings: held.rings }),
                    ...(held?.deliveries && { deliveries: held.deliveries }),
                  },
                },
              })
            })
          } catch (error) {
            reportCaught(error)
          }
          if (ringSeq > have) void pull(() => ringSeq)
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

  const unfollow = (key: TerminalKey): void => {
    const id = terminalKeyPath(key)
    const stream = followed.get(id)
    followed.delete(id)
    void stream?.return?.()
    forget(id)
  }

  // A release or a stop: the thread goes on once a listing shows it no longer held.
  const settle = (thread: string, call: () => Promise<void>, what: string): void => {
    state.update((current) => {
      const { [thread]: _before, ...failed } = current.failed
      return { ...current, releasing: { ...current.releasing, [thread]: "asked" }, failed }
    })
    track(call()).then(
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
            : { ...current.failed, [thread]: `Couldn't ${what} it: ${reasonOf(error)}` },
        })),
    )
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
            error: `Couldn't ${paused ? "pause" : "resume"} messaging: ${reasonOf(error)}`,
          })),
      )
    },
    release: (thread) => settle(thread, () => streams.release(thread), "release"),
    stop: (thread) => settle(thread, () => streams.stop(thread), "stop"),
    follow,
    unfollow,
    end: () => {
      for (const [id, stream] of followed) {
        followed.delete(id)
        void stream.return?.()
      }
      state.update((current) => ({ ...current, terminals: {} }))
    },
  }
}
