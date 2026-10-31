import type { ActivityEvent } from "@novadeck/harness-core/events"

import type { Binding } from "../harnesses/bindings.js"
import type { Root } from "../harnesses/roots.js"
import { logs } from "../log.js"
import { phaseOf, type DeliveryEvent } from "./delivery.js"
import type { Grants } from "./grants.js"
import { Leases, type Lease } from "./leases.js"
import { addressed, feed, type Live } from "./live.js"
import type { Loops } from "./loops.js"
import type { MessageStore } from "./message-store.js"
import {
  byteLength,
  deliveryOf,
  maxDeliveryBytes,
  newMark,
  wrap,
  type Message,
} from "./messages.js"
import type { Sessions } from "./sessions.js"
import type { Notices, Withdrawal } from "./withdrawals.js"

const log = logs.for("messaging")

/** Whether a message is its recipient's lead's, as fixed when it was sent. */
export const isFromLead = (message: Message): boolean => message.fromLead

/** What leasing asks of the rest of messaging. */
export type LeasingHost = {
  readonly sessions: Sessions
  readonly store: MessageStore
  readonly loops: Loops
  readonly now: () => number
  /** Moves the terminal's delivery on (`Deliveries.step`). */
  readonly step: (live: Live, event: DeliveryEvent) => void
  /** The grants, for the grant elements a delivery renders (`Grants.get`). */
  readonly grants: Pick<Grants, "get">
}

/**
 * The leases (`leases.ts`) of the messages a hook prints: given as it answers, confirmed by
 * its acknowledgement, which delivers them, and let lapse when none comes, when they wait
 * again and a Stop they would have continued ends its turn.
 */
export class Leasing {
  private readonly leases: Leases

  constructor(
    leaseMs: number,
    private readonly host: LeasingHost,
  ) {
    this.leases = new Leases(leaseMs, (lease) => this.lapse(lease))
  }

  /** What the turn in the terminal is given again on each later call, if it was given any. */
  recall(terminalId: string, epoch: number): string | undefined {
    return this.leases.recall(terminalId, epoch)
  }

  /** Leaves behind the terminal's last delivery, as its turn ended or a new one began. */
  forget(terminalId: string): void {
    this.leases.forget(terminalId)
  }

  /** Drops every lease, unacknowledged: their messages wait for the next runner. */
  clear(): void {
    this.leases.clear()
  }

  /**
   * Leases the messages waiting for the root session (those `only` takes, where it is
   * given), as many as one delivery carries once `print` prints it as its harness reads it,
   * until the hook acknowledges them; none when none wait. `keeps` is what the turn is given
   * again on each later call once printed, where its harness's injected messages last one;
   * `settles` is the withdrawal its notices tell of, made once it is acknowledged.
   */
  lease(
    live: Live,
    root: Root,
    options: {
      readonly kind: Lease["kind"]
      readonly background?: boolean
      readonly print: (text: string) => string
      readonly only?: (message: Message) => boolean
      readonly keeps?: (text: string) => string
      /** Run when the hook acknowledges the lease: the withdrawal its notices tell of. */
      readonly settles?: Withdrawal | undefined
    },
  ): Lease | undefined {
    const { store } = this.host
    // Once closed, nothing is saved, so no ack could record a delivery: the next runner
    // would deliver again what a hook printed now. Its messages wait for that runner.
    if (store.closed) return undefined
    const { kind, background = false, print, only = () => true, keeps, settles } = options
    const queued = [...store.messages()]
      .filter(({ state, ...message }) => state === "queued" && addressed(message, root))
      .filter((message) => message.to.terminalId === live.terminalId && only(message))
      .toSorted((a, b) => a.sentAt - b.sentAt)
    if (queued.length === 0) return undefined
    // One mark for the delivery, which marks its lead's messages. What counts is the bytes
    // printed, escaped as the harness reads them.
    const mark = newMark()
    const wrapped = { grants: (id: string) => this.host.grants.get(id) }
    const prints = (taken: readonly Message[]) =>
      byteLength(print(wrap(taken, isFromLead, mark, undefined, wrapped)))
    const messages = deliveryOf(queued, (taken) => prints(taken) <= maxDeliveryBytes)
    // The first always goes, as it fits alone; beside what the turn holds it may not.
    if (messages.length === 0 || prints(messages) > maxDeliveryBytes) return undefined
    for (const message of messages) store.put({ ...message, state: "leased" })
    const text = wrap(messages, isFromLead, mark, undefined, wrapped)
    return this.leases.grant({
      terminalId: live.terminalId,
      messages: messages.map((message) => message.id),
      kind,
      epoch: live.delivery.epoch,
      background,
      text,
      ...(keeps && { keeps: keeps(text) }),
      ...(settles && { settles: settles.settle, asks: settles.asks }),
    })
  }

  /**
   * A lease that carries only Novadeck's notices, for an answer whose messages are none (or
   * too many to fit beside them), when it settles the withdrawal, which then also keeps what
   * the turn is given again on each later call (`keeps`). Notices that withdraw nothing need
   * no lease: what they keep is kept at once, as they are spent at once.
   */
  noticed(
    live: Live,
    kind: Lease["kind"],
    { withdrawal }: Notices,
    keeps: string | undefined,
  ): Lease | undefined {
    if (this.host.store.closed) return undefined
    if (!withdrawal) {
      if (keeps !== undefined) this.leases.remember(live.terminalId, live.delivery.epoch, keeps)
      return undefined
    }
    return this.leases.grant({
      terminalId: live.terminalId,
      messages: [],
      kind,
      epoch: live.delivery.epoch,
      background: false,
      text: "",
      ...(keeps !== undefined && { keeps }),
      ...(withdrawal && { settles: withdrawal.settle, asks: withdrawal.asks }),
    })
  }

  /**
   * A hook printed what its lease delivers: its messages are delivered. An ack for a
   * lease that lapsed, was given again, or is another terminal's, is ignored.
   */
  acknowledge(terminalId: string, leaseId: string): void {
    const { store } = this.host
    const lease = this.leases.take(terminalId, leaseId)
    if (!lease) return
    const at = this.host.now()
    for (const id of lease.messages) {
      const message = store.message(id)
      if (message?.state === "leased")
        store.put({ ...message, state: "delivered", deliveredAt: at })
    }
    // What a stale lease keeps would overwrite the text the turn now in progress is given.
    if (
      lease.keeps !== undefined &&
      this.host.sessions.get(terminalId)?.delivery.epoch === lease.epoch
    )
      this.leases.remember(terminalId, lease.epoch, lease.keeps)
    lease.settles?.()
  }

  /**
   * Whether a Stop Novadeck continued lapsed since this was last asked, as an event for
   * the bound session's activity, so both tell the turn ended there. Told once.
   */
  lapsed(terminalId: string, binding: Binding, turnAt: number): ActivityEvent | undefined {
    const live = this.host.sessions.get(terminalId)
    if (!live?.lapsed) return undefined
    live.lapsed = false
    const { agent, sessionId, instance } = binding
    const event: ActivityEvent = {
      type: "turn-lapsed",
      agent,
      sessionId,
      instance,
      startedAt: turnAt,
    }
    feed(this.host.loops, this.host.now, live, [event])
    return event
  }

  /**
   * A lease its hook never acknowledged: its messages wait again. A Stop it would have
   * continued was not continued, so its turn ended there, unless the turn has moved on
   * since, as when the hook printed it and only its acknowledgement was lost.
   */
  private lapse(lease: Lease): void {
    const { sessions, store } = this.host
    // Nothing to restore: the asks were never withdrawn, and the prompt's debt stands. Told
    // only while it does: another hook's acknowledgement of the same notice may have paid it.
    if (lease.settles && sessions.get(lease.terminalId)?.withdrawing)
      log.info(
        "messaging.notice-lapsed",
        "A hook never acknowledged the notice of asks to withdraw.",
        {
          data: { terminalId: lease.terminalId, kind: lease.kind, asks: lease.asks ?? 0 },
        },
      )
    for (const id of lease.messages) {
      const message = store.message(id)
      if (message?.state !== "leased") continue
      // One the person's release marked stopped is gone (`wait`); any other end of the lead
      // leaves a message its authority, as it had when sent.
      store.wait(message)
    }
    const live = sessions.get(lease.terminalId)
    if (!live || lease.kind !== "stop") return
    const { delivery } = live
    if (delivery.epoch === lease.epoch && phaseOf(delivery) === "continuing") {
      live.lapsed = true
      this.host.step(live, {
        type: "stop",
        continued: false,
        background: lease.background,
        at: this.host.now(),
      })
    }
  }
}
