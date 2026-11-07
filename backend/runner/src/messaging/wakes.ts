import type { Live } from "./live.js"
import type { MessageStore } from "./message-store.js"
import type { Message } from "./messages.js"
import type { Sessions } from "./sessions.js"

/** What wakes ask of the rest of messaging. */
export type WakesHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  /** A terminal asleep gains a message that will be delivered: its agent should be woken. */
  readonly onWake: ((terminalId: string) => void) | undefined
}

/**
 * What wakes a terminal asleep: a queued message for it that nothing holds back, as the
 * person's reply, an agent's message, a release or the end of a pause make one. The
 * terminal manager starts the process; messaging only says when one is wanted, and what
 * becomes of the messages when it fails.
 */
export class Wakes {
  /** The resting session each terminal's wake was asked for, so it is asked once for each. */
  private readonly asked = new Map<string, Live["resting"]>()

  constructor(private readonly host: WakesHost) {
    host.store.subscribe((change) => {
      if (change.kind === "terminal") this.follow(change.terminalId)
    })
  }

  /** Whether a message waits for the terminal that will be delivered: none holds it back. */
  private wants(message: Message): boolean {
    return message.state === "queued" && this.host.store.holdOf(message) === null
  }

  /** Whether a queued message addressed to the terminal is held by nothing. */
  wanted(terminalId: string): boolean {
    for (const message of this.host.store.messages())
      if (message.to.terminalId === terminalId && this.wants(message)) return true
    return false
  }

  /** Every terminal a message waits for that nothing holds back, in one pass over messages. */
  allWanted(): ReadonlySet<string> {
    const ids = new Set<string>()
    for (const message of this.host.store.messages())
      if (this.wants(message)) ids.add(message.to.terminalId)
    return ids
  }

  /**
   * The wake failed: the messages that wanted it are gone, for `reason`, and their senders
   * hear. The terminal rests as it was.
   */
  failed(terminalId: string, reason: string): void {
    const { store } = this.host
    for (const message of store.messages())
      if (message.to.terminalId === terminalId && this.wants(message)) store.gone(message, reason)
  }

  /** Asks for the wake of an asleep terminal that gained a message to deliver, once. */
  private follow(terminalId: string): void {
    const { sessions } = this.host
    const live = sessions.asleep(terminalId) ? sessions.get(terminalId) : undefined
    if (!live) return void this.asked.delete(terminalId)
    if (!this.wanted(terminalId)) return void this.asked.delete(terminalId)
    if (this.asked.get(terminalId) === live.resting) return
    this.asked.set(terminalId, live.resting)
    this.host.onWake?.(terminalId)
  }
}
