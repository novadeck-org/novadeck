import { randomBytes } from "node:crypto"

/** Messages handed to a hook that has yet to say it printed them. */
export type Lease = {
  readonly id: string
  readonly terminalId: string
  readonly messages: readonly string[]
  readonly kind: "stop" | "prompt"
  /** The delivery's epoch it was leased in. */
  readonly epoch: number
  readonly background: boolean
  /** The delivery it printed, wrapped. */
  readonly text: string
}

/**
 * The leases handed to terminals' hooks (see docs/agent-messaging.md, "Hook answers"): each
 * lasts until its hook acknowledges it, or lapses after `ms`, when `lapsed` hears of it.
 * They also keep each terminal's prompt-time delivery for its turn, for a harness whose
 * injected messages last one model call, so each later call of the turn gets it again.
 */
export class Leases {
  private readonly leases = new Map<
    string,
    { readonly lease: Lease; readonly timer: ReturnType<typeof setTimeout> }
  >()
  private readonly reinjected = new Map<string, { readonly epoch: number; readonly text: string }>()

  constructor(
    private readonly ms: number,
    private readonly lapsed: (lease: Lease) => void,
  ) {}

  /** A new lease of the messages, with an id no one can guess. */
  grant(fields: Omit<Lease, "id">): Lease {
    let id = randomBytes(18).toString("base64url")
    while (this.leases.has(id)) id = randomBytes(18).toString("base64url")
    const lease = { ...fields, id }
    const timer = setTimeout(() => {
      this.leases.delete(id)
      this.lapsed(lease)
    }, this.ms)
    timer.unref()
    this.leases.set(id, { lease, timer })
    return lease
  }

  /** The terminal's lease its hook acknowledged, ended; undefined for one lapsed or another's. */
  take(terminalId: string, leaseId: string): Lease | undefined {
    const held = this.leases.get(leaseId)
    if (!held || held.lease.terminalId !== terminalId) return undefined
    clearTimeout(held.timer)
    this.leases.delete(leaseId)
    return held.lease
  }

  /** Keeps a turn's prompt-time delivery, for each later call of the turn. */
  remember(terminalId: string, epoch: number, text: string): void {
    this.reinjected.set(terminalId, { epoch, text })
  }

  /** The delivery a later call of the turn gets again, if its first got one. */
  recall(terminalId: string, epoch: number): string | undefined {
    const kept = this.reinjected.get(terminalId)
    return kept?.epoch === epoch ? kept.text : undefined
  }

  /** Lets go of the terminal's turn's delivery, as its turn ended. */
  forget(terminalId: string): void {
    this.reinjected.delete(terminalId)
  }

  /** Ends every lease without a word; they wait again with the next runner. */
  clear(): void {
    for (const { timer } of this.leases.values()) clearTimeout(timer)
    this.leases.clear()
    this.reinjected.clear()
  }
}
