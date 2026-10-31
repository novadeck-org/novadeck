import { longHoldMs } from "@novadeck/protocol"

import { DomainError } from "../errors.js"
import { mention } from "../terminals/handles.js"
import { ringableSince, waitReasons, waitsIn, type Waits } from "./delivery.js"
import { addressed, awaiting, promptsInBackground, type Live } from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import {
  clock,
  idleToHold,
  isBetween,
  senderTerminal,
  stopBlocks,
  type Message,
} from "./messages.js"
import type { Sessions } from "./sessions.js"

/** Message ids as a notice names them: the first few, then how many more. */
const named = (ids: readonly string[]): string =>
  ids.length <= 4 ? ids.join(", ") : `${ids.slice(0, 3).join(", ")} and ${ids.length - 3} more`

/**
 * What a sender is told of its messages held long behind what keeps their recipient's
 * doorbell from it (`waits`, since `since`), in its next answer or hook.
 */
export const holdNotice = (
  ids: readonly string[],
  to: string,
  waits: Waits | null,
  since: number,
): string =>
  `Novadeck: your ${ids.length === 1 ? "message" : "messages"} ${named(ids)} to ${mention(to)} ` +
  `${ids.length === 1 ? "has" : "have"} not arrived since ${clock(since)} ` +
  `(${waits ? waitReasons[waits] : "its agent is idle, but Novadeck can't wake it yet"}); ` +
  "the user is shown this in Novadeck's Inbox."

/** A thread's idle messages in a row, and who sent them. */
export type Run = { count: number; senders: readonly string[] }

/** What holds ask of the rest of messaging. */
export type HoldsHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  /** Whether the agent's activity says a turn or subagents run there (`MessagingOptions.busy`). */
  readonly busy: (terminalId: string) => boolean
}

/**
 * What holds messages back: a thread held for the person's release, as a loop of idle
 * messages holds it, and the person's release or stop of it; and messages held long behind
 * what keeps their recipient's doorbell from it, which their sender is told of.
 */
export class Holds {
  /**
   * Each thread's idle messages in a row, and who sent them, kept in memory only: a restart
   * starts the count afresh. Frozen while the thread is held.
   */
  private readonly runs = new Map<string, Run>()
  /** The messages judged idle when sent, for the reason their sender is told; in memory only. */
  private readonly idled = new Set<string>()

  constructor(private readonly host: HoldsHost) {}

  /** The thread's run of idle messages, if it has one. */
  run(threadId: string): Run | undefined {
    return this.runs.get(threadId)
  }

  /** Sets the thread's run of idle messages, as a message sent in it counts. */
  setRun(threadId: string, run: Run): void {
    this.runs.set(threadId, run)
  }

  /** Notes that the message was judged idle when sent. */
  idle(messageId: string): void {
    this.idled.add(messageId)
  }

  /** The message was forgotten. */
  forgot(messageId: string): void {
    this.idled.delete(messageId)
  }

  /** The thread was forgotten. */
  forgotThread(threadId: string): void {
    this.runs.delete(threadId)
  }

  /** Since when the messages for the terminal have been held, the longest; null if none is. */
  oldestHeld(live: Live): number | null {
    let oldest: number | null = null
    for (const message of this.host.store.messages()) {
      if (message.to.terminalId !== live.terminalId) continue
      const since = this.heldSince(live, message)
      if (since !== undefined && (oldest === null || since < oldest)) oldest = since
    }
    return oldest
  }

  /** Why the doorbell can't ring the terminal's idle agent, as its listing says; null if not. */
  waitsOf(live: Live): Waits | null {
    return waitsIn(live.delivery, promptsInBackground(live)) ||
      ringableSince(live.delivery) !== undefined
      ? live.waits
      : null
  }

  /**
   * The caller's messages held at least `longHoldMs` behind what keeps their recipient's
   * doorbell from it, as words: told now, once for each hold.
   */
  heldFrom(terminalId: string): readonly string[] {
    const now = this.host.now()
    const held = new Map<
      string,
      { live: Live; waits: Waits | null; since: number; ids: string[] }
    >()
    for (const message of this.host.store.messages()) {
      if (senderTerminal(message.from) !== terminalId) continue
      const to = this.host.sessions.get(message.to.terminalId)
      const since = to && this.heldSince(to, message)
      if (!to || since === undefined || now - since < longHoldMs) continue
      const waits = this.waitsOf(to)
      if (!this.host.store.tellHold(message.id, since)) continue
      const each = held.get(to.terminalId) ?? { live: to, waits, since, ids: [] }
      each.since = Math.min(each.since, since)
      each.ids.push(message.id)
      held.set(to.terminalId, each)
    }
    return [...held.values()].map(({ live, waits, since, ids }) =>
      holdNotice(ids, live.handle, waits, since),
    )
  }

  /**
   * Since when a message waiting for the terminal's idle agent has been held there: the
   * later of when the agent last went idle and when the message last came to wait (its
   * sending, or a pause's or a release's end); undefined unless both hold now.
   */
  private heldSince(live: Live, message: Message): number | undefined {
    const { idleSince, root } = live
    if (idleSince === null || message.state !== "queued" || this.host.busy(live.terminalId))
      return undefined
    // Only what the doorbell rings for: a message for the root session, or the one to bind.
    if (root ? !addressed(message, root) : !awaiting(live, message)) return undefined
    return Math.max(idleSince, this.host.store.queuedAt(message.id) ?? message.sentAt)
  }

  /**
   * Whether a message sent now by `sender` to `recipient` is idle: not the thread's first,
   * neither end worked since its previous message at `from` (unknown counts as work), and
   * no response from the person reached either end meanwhile.
   */
  idleSince(from: number, now: number, sender: string, recipient: string): boolean {
    const { loops } = this.host
    if (loops.worked(sender, from, now) !== false) return false
    if (loops.worked(recipient, from, now) !== false) return false
    return ![...this.host.store.messages()].some(
      (message) =>
        message.response !== undefined &&
        (message.to.terminalId === sender || message.to.terminalId === recipient) &&
        message.deliveredAt !== null &&
        message.deliveredAt > from &&
        message.deliveredAt <= now,
    )
  }

  /**
   * Where a new thread between two terminals starts: while any of their messages waits held
   * for release, with the run of idle messages that held it, judged from their last message;
   * undefined when none waits.
   */
  carriedRun(a: string, b: string) {
    const held = this.heldForRelease(a, b)
    if (held.length === 0) return undefined
    const run = held.map((message) => this.runs.get(message.thread)).find((each) => each?.count)
    const last = [...this.host.store.messages()]
      .filter((message) => !message.response && isBetween(message, a, b))
      .reduce((newest, message) => Math.max(newest, message.sentAt), 0)
    return { from: last, run: run ?? { count: idleToHold, senders: [] } }
  }

  /** How many messages between two terminals wait held for release, across their threads. */
  heldBetween(a: string, b: string): number {
    return this.heldForRelease(a, b).length
  }

  /** The messages between two terminals that wait held for release, across their threads. */
  private heldForRelease(a: string, b: string): Message[] {
    const { store } = this.host
    return [...store.messages()].filter(
      (message) =>
        !message.response &&
        message.state === "held" &&
        isBetween(message, a, b) &&
        store.holdOf(message) === "release",
    )
  }

  /**
   * What a message held for release tells its sender of why (see docs/agent-messaging.md,
   * Guards, "Loops"); undefined for any other.
   */
  holdWhy(message: Message): string | undefined {
    if (this.host.store.holdOf(message) !== "release") return undefined
    const thread = this.host.store.thread(message.thread)
    const peer = mention(message.to.handle)
    if (thread?.heldFor !== "loop") return `your thread with ${peer} waits for the user's release.`
    if (!this.idled.has(message.id))
      return (
        `your thread with ${peer} is held because it went on with no work done at either end; ` +
        "it arrives once the user releases it."
      )
    const senders = this.runs.get(message.thread)?.senders ?? []
    const own = senders.length > 0 && senders.every((each) => each === senderTerminal(message.from))
    return (
      (own ? `you kept messaging ${peer}` : `you and ${peer} kept messaging`) +
      " while neither of you did any work, so Novadeck holds your thread until the user " +
      `releases it. Get on with the work, or wait for the user, rather than messaging ${peer} again.`
    )
  }

  /**
   * Releases a thread, and, when it has a hold, every other held thread of its pair (a loop
   * may hold a new thread beside an old one): the holds end and their held messages wait to
   * be delivered (held still while paused), and the counts of idle messages start afresh. A
   * stopped thread is no longer stopped, but its messages that went stay gone.
   */
  release(threadId: string): void {
    const { store } = this.host
    const thread = store.thread(threadId)
    if (!thread) throw new DomainError("NOT_FOUND")
    const [a, b] = thread.between
    const released = [...store.threads()].filter(
      (each) =>
        each.id === threadId ||
        (thread.heldFrom !== null &&
          each.heldFrom !== null &&
          ((each.between[0] === a && each.between[1] === b) ||
            (each.between[0] === b && each.between[1] === a))),
    )
    const ids = new Set(released.map(({ id }) => id))
    for (const each of released) {
      store.putThread({
        ...each,
        heldFrom: null,
        heldFor: null,
        ...(each.id === threadId && { stoppedAt: null }),
      })
      // A thread with no hold keeps its count.
      if (each.heldFrom !== null) this.runs.delete(each.id)
    }
    const terminals = new Set<string>([a, b])
    for (const message of store.messages()) {
      if (!ids.has(message.thread)) continue
      if (message.from.kind === "agent") terminals.add(message.from.terminalId)
      terminals.add(message.to.terminalId)
      if (message.state === "held") store.wait(message)
    }
    // Its hold ended, whether or not any message waited.
    for (const terminalId of terminals) store.changed(terminalId)
  }

  /**
   * Stops a thread: its messages still queued or held are gone, their senders told the
   * person stopped it; one a lease holds is left to finish. A message that would continue
   * it is refused until it lapses (`threadMs`) or the person releases it. Stopping a
   * stopped thread does nothing. Its hold ends, and its count starts afresh; its gone
   * messages that could wait again are marked stopped, so none does.
   */
  stop(threadId: string): void {
    const { store } = this.host
    const thread = store.thread(threadId)
    if (!thread) throw new DomainError("NOT_FOUND")
    if (stopBlocks(thread, this.host.now())) return
    store.putThread({ ...thread, heldFrom: null, heldFor: null, stoppedAt: this.host.now() })
    this.runs.delete(threadId)
    const terminals = new Set<string>()
    for (const message of store.messages()) {
      if (message.thread !== threadId) continue
      if (message.from.kind === "agent") terminals.add(message.from.terminalId)
      terminals.add(message.to.terminalId)
      if (message.state === "queued" || message.state === "held") {
        store.noteGone(message, "thread-stopped")
        store.put({ ...message, state: "gone", notified: false, stopped: true })
      } else if (message.state === "gone" && !message.stopped && !message.response) {
        // Its session may run again; it won't be waited for, and its sender's notice stands.
        store.put({ ...message, stopped: true })
      }
    }
    for (const terminalId of terminals) store.changed(terminalId)
  }
}
