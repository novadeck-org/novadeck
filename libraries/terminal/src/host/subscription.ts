import { TerminalError, type TerminalEvent } from "../contract.js"

type Delivery<E> = { event: E; bytes: number }
type Outstanding = { bytes: number; snapshot: boolean }

const jsonBytes = (event: unknown): number => Buffer.byteLength(JSON.stringify(event))

/**
 * Bounds both queued events and events already handed to the transport. Each event counts
 * at `eventBytes`, by default its JSON's size: what the transport sends, so a host whose
 * transport wraps events in an envelope counts them in it.
 */
export class Subscription<E extends TerminalEvent = TerminalEvent> {
  readonly mode: "control" | "observe"
  private readonly queue: Delivery<E>[] = []
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
    private readonly eventBytes: (event: E) => number = jsonBytes,
  ) {
    this.mode = mode
  }

  push(event: E): void {
    if (this.finished || this.error) return
    const bytes = this.eventBytes(event)
    if (event.type === "snapshot") {
      if (bytes > this.snapshotLimit) {
        this.fail(
          new TerminalError(
            "SNAPSHOT_TOO_LARGE",
            "Visible terminal screen exceeds the configured snapshot allowance.",
          ),
        )
        return
      }
      if (this.snapshotAccepted || this.queue.length > 0 || this.delivered >= 0) {
        this.fail(
          new TerminalError(
            "SLOW_CONSUMER",
            "Terminal stream may contain only one initial snapshot.",
          ),
        )
        return
      }
      this.snapshotAccepted = true
    } else if (this.bytes + this.liveSentBytes + bytes > this.limit) {
      this.fail(
        new TerminalError("SLOW_CONSUMER", "Terminal viewer must reconnect to resynchronize."),
      )
      return
    }
    this.queue.push({ event, bytes })
    if (event.type !== "snapshot") this.bytes += bytes
    this.notify()
  }

  ack(sequence: number): void {
    if (sequence > this.delivered) {
      throw new TerminalError("INVALID_CURSOR", "Cannot acknowledge an undelivered terminal event.")
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

  async next(): Promise<E | undefined> {
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
