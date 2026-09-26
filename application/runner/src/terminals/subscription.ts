import type { TerminalEvent } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

type Delivery = { event: TerminalEvent; bytes: number }
type Outstanding = { bytes: number; snapshot: boolean }

/** Bounds both queued events and events already handed to the transport. */
export class Subscription {
  readonly mode: "control" | "observe"
  private readonly queue: Delivery[] = []
  private readonly outstanding = new Map<number, Outstanding>()
  private bytes = 0
  private sentBytes = 0
  private liveSentBytes = 0
  private snapshotAccepted = false
  private delivered = -1
  private acknowledged = -1
  private finished = false
  private error: Error | undefined
  private wake: (() => void) | undefined

  constructor(
    mode: "control" | "observe",
    private readonly limit: number,
    private readonly window: number,
    private readonly detach: () => void,
    private readonly snapshotLimit: number = limit,
  ) {
    this.mode = mode
  }

  push(event: TerminalEvent): void {
    if (this.finished || this.error) return
    const bytes = Buffer.byteLength(JSON.stringify(event))
    if (event.type === "snapshot") {
      if (bytes > this.snapshotLimit) {
        this.fail(
          new DomainError(
            "SNAPSHOT_TOO_LARGE",
            "Visible terminal screen exceeds the configured snapshot allowance.",
          ),
        )
        return
      }
      if (this.snapshotAccepted || this.queue.length > 0 || this.delivered >= 0) {
        this.fail(
          new DomainError(
            "SLOW_CONSUMER",
            "Terminal stream may contain only one initial snapshot.",
          ),
        )
        return
      }
      this.snapshotAccepted = true
    } else if (this.bytes + this.liveSentBytes + bytes > this.limit) {
      this.fail(
        new DomainError("SLOW_CONSUMER", "Terminal viewer must reconnect to resynchronize."),
      )
      return
    }
    this.queue.push({ event, bytes })
    if (event.type !== "snapshot") this.bytes += bytes
    this.notify()
  }

  ack(sequence: number): void {
    if (sequence > this.delivered) {
      throw new DomainError("INVALID_CURSOR", "Cannot acknowledge an undelivered terminal event.")
    }
    if (sequence <= this.acknowledged) return
    this.acknowledged = sequence
    for (const [cursor, delivery] of this.outstanding) {
      if (cursor > sequence) continue
      this.outstanding.delete(cursor)
      this.sentBytes -= delivery.bytes
      if (!delivery.snapshot) this.liveSentBytes -= delivery.bytes
    }
    this.notify()
  }

  finish(): void {
    this.finished = true
    this.notify()
  }

  cancel(): void {
    this.queue.length = 0
    this.outstanding.clear()
    this.bytes = 0
    this.sentBytes = 0
    this.liveSentBytes = 0
    this.finish()
  }

  async next(): Promise<TerminalEvent | undefined> {
    while (true) {
      if (this.error) throw this.error
      const delivery = this.queue[0]
      // One initial snapshot has its own allowance; all outstanding bytes still gate delivery.
      if (delivery && (this.sentBytes === 0 || this.sentBytes + delivery.bytes <= this.window)) {
        this.queue.shift()
        const snapshot = delivery.event.type === "snapshot"
        if (!snapshot) {
          this.bytes -= delivery.bytes
          this.liveSentBytes += delivery.bytes
        }
        this.sentBytes += delivery.bytes
        this.delivered = delivery.event.sequence
        this.outstanding.set(delivery.event.sequence, { bytes: delivery.bytes, snapshot })
        return delivery.event
      }
      if (this.finished && !delivery) return undefined
      // eslint-disable-next-line no-await-in-loop -- Wait for output or an ACK before retrying delivery.
      await new Promise<void>((resolve) => {
        this.wake = resolve
      })
    }
  }

  private fail(error: Error): void {
    this.error = error
    this.cancel()
    this.detach()
  }

  private notify(): void {
    const wake = this.wake
    this.wake = undefined
    wake?.()
  }
}
