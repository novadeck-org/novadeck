import type { DeliveryState, MessageState, TerminalMessages } from "@novadeck/protocol"

/**
 * A terminal's messages as a client saw them at one moment: its delivery state and each
 * message's state, numbered in the order they came.
 */
export type Snapshot = {
  /** Its place in the terminal's history, from 0. */
  readonly index: number
  /** When it came, in milliseconds since the epoch. */
  readonly at: number
  readonly delivery: DeliveryState
  readonly paused: boolean
  /** Every message the terminal sent or received, oldest first within each thread. */
  readonly messages: readonly {
    readonly id: string
    readonly from: string
    readonly to: string
    readonly state: MessageState
  }[]
}

/**
 * What a snapshot must be to be reached: a delivery state, or a test of the snapshot,
 * which a failed wait calls by its function's name (see `named`).
 */
export type Reach = DeliveryState | ((snapshot: Snapshot) => boolean)

export type ReachOptions = {
  /** A `mark`: only snapshots from it on count. From the start when omitted. */
  readonly after?: number
  /**
   * Where a failed wait's account of the transitions starts, when it should start before
   * `after`, as for a step of several waited for in order. `after` unless given.
   */
  readonly since?: number
  /** Thirty seconds unless given. */
  readonly timeoutMs?: number
  /** Why waiting is pointless, when it is: the wait fails at once with it. */
  readonly fault?: () => string | undefined
}

/** A test of a snapshot, named as a failed wait says what it waited for. */
export const named = (
  label: string,
  test: (snapshot: Snapshot) => boolean,
): ((snapshot: Snapshot) => boolean) => Object.defineProperty(test, "name", { value: label })

/** What a failed wait says it waited for: the state, or the test's name. */
export const wanted = (what: Reach): string =>
  typeof what === "function" ? what.name || "the state asked for" : what

/**
 * Every listing of a terminal's messages, from the first, as a watch of them delivers
 * each change: no state between two looks at it is missed, as one that polled could. A
 * burst of changes within one tick reaches it, as any client, as one listing.
 */
export type History = {
  /** Records a listing as the next snapshot. */
  readonly push: (listing: TerminalMessages) => void
  /** Ends the history: waits still pending fail, saying why. */
  readonly end: (why: string) => void
  readonly snapshots: () => readonly Snapshot[]
  /** How many snapshots there are so far: a cursor `reached` takes as `after`. */
  readonly mark: () => number
  /**
   * The first snapshot from `after` on that is what's asked, as soon as there is one. On
   * timeout it fails with the delivery states the terminal went through from `after` on.
   */
  readonly reached: (what: Reach, options?: ReachOptions) => Promise<Snapshot>
}

const snapshotOf = (listing: TerminalMessages, index: number): Snapshot => ({
  index,
  at: Date.now(),
  delivery: listing.delivery,
  paused: listing.paused,
  messages: listing.threads.flatMap((thread) =>
    thread.messages.map(({ id, from, to, state }) => ({ id, from, to, state })),
  ),
})

const test = (what: Reach) =>
  typeof what === "function" ? what : (snapshot: Snapshot) => snapshot.delivery === what

/**
 * The delivery states snapshots went through, a state repeated as only a message changed
 * shown once, and the messages' states at the last: `t2: ready → ringing → unknown;
 * messages m-1 delivered`.
 */
export const transitions = (handle: string, snapshots: readonly Snapshot[]): string => {
  const states = snapshots
    .map((snapshot) => snapshot.delivery)
    .filter((state, index, all) => index === 0 || state !== all[index - 1])
  const last = snapshots.at(-1)?.messages ?? []
  const messages = last.map((message) => `${message.id} ${message.state}`).join(", ")
  return `${handle}: ${states.join(" → ") || "(no change)"}${messages ? `; messages ${messages}` : ""}`
}

/** A terminal's history of messages, named by its handle in what a failed wait says. */
export const createHistory = (handle: string): History => {
  const snapshots: Snapshot[] = []
  const waiters = new Set<{
    readonly see: (snapshot: Snapshot) => void
    readonly fail: (why: string) => void
  }>()
  let ended: string | undefined

  return {
    push: (listing) => {
      if (ended !== undefined) return
      const snapshot = snapshotOf(listing, snapshots.length)
      snapshots.push(snapshot)
      for (const waiter of waiters) waiter.see(snapshot)
    },
    end: (why) => {
      ended ??= why
      for (const waiter of waiters) waiter.fail(why)
    },
    snapshots: () => snapshots,
    mark: () => snapshots.length,
    reached: (what, { after = 0, since = after, timeoutMs = 30_000, fault } = {}) => {
      const matches = test(what)
      let found: Snapshot | undefined
      try {
        found = snapshots.slice(after).find(matches)
      } catch (error) {
        return Promise.reject(error)
      }
      if (found) return Promise.resolve(found)
      // What it went through from `since` on, from the state it was in then.
      const account = (why: string) =>
        new Error(
          `${handle} can't reach ${wanted(what)}: ${why}. ${transitions(handle, snapshots.slice(Math.max(since - 1, 0)))}`,
        )
      if (ended !== undefined) return Promise.reject(account(ended))
      const refused = fault?.()
      if (refused !== undefined) return Promise.reject(account(refused))
      return new Promise((resolve, reject) => {
        const waiter = {
          // A test that throws fails this wait alone, with its own error; the history and
          // every other wait carry on.
          see: (snapshot: Snapshot) => {
            let met: boolean
            try {
              met = matches(snapshot)
            } catch (error) {
              settle()
              reject(error)
              return
            }
            if (!met) return
            settle()
            resolve(snapshot)
          },
          fail: (why: string) => {
            settle()
            reject(account(why))
          },
        }
        const timer = setTimeout(() => waiter.fail(`timed out after ${timeoutMs} ms`), timeoutMs)
        const watch = fault
          ? setInterval(() => {
              const why = fault()
              if (why !== undefined) waiter.fail(why)
            }, 100)
          : undefined
        const settle = () => {
          clearTimeout(timer)
          clearInterval(watch)
          waiters.delete(waiter)
        }
        waiters.add(waiter)
      })
    },
  }
}
