import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract"

import type { Session, Wire } from "./connection.js"
import { hasCode, normalize, WireError } from "./errors.js"

/**
 * A stream that resumes from a cursor: each item may carry its position, a reconnection asks
 * for what comes after the last one read, and the server is told what was read with `ack`.
 */
export type CursorResume<C extends AnyContractRouter, T> = {
  /** An item's position; an item without one, such as a marker, moves nothing. */
  readonly cursor: (item: T) => number | undefined
  /** Tells the server the reader is done with everything up to `position`. */
  readonly ack: (client: ContractRouterClient<C>, position: number) => Promise<unknown>
}

/** A stream that starts over on each new subscription, as one of the whole state does. */
export type RestartResume<T> = {
  readonly restart: true
  /** Said before each new subscription's items, so a reader knows what follows replaces them. */
  readonly reset?: T
  /**
   * Holds `reset` back until the new subscription yields something, so one that finds nothing
   * doesn't wipe what came before; the first subscription, with nothing before it, has none.
   */
  readonly holdReset?: boolean
}

export type FollowOptions<C extends AnyContractRouter, T> = {
  /** Opens the stream on a session, after `after` where the stream resumes from a cursor. */
  readonly open: (
    client: ContractRouterClient<C>,
    options: { readonly after?: number; readonly signal: AbortSignal },
  ) => Promise<AsyncIterable<T>> | AsyncIterable<T>
  readonly resume: CursorResume<C, T> | RestartResume<T>
  /**
   * For a restarting stream: whether a failure says its subject is gone, which ends it. A stream that
   * can lose its subject is opened again as soon as it ends, to learn whether it's still there;
   * one that can't ends only as its server goes, and is opened again on the next connection.
   */
  readonly gone?: (error: WireError) => boolean
}

/** A followed stream, as its reader holds it. */
export type Following<C extends AnyContractRouter, T> = AsyncIterableIterator<T, undefined> & {
  /** Stops following, ending a pending read and cancelling the stream. */
  return(): Promise<IteratorResult<T, undefined>>
  /** The session the stream is open on, until it closes; undefined while it opens again. */
  readonly session: Session<C> | undefined
  /**
   * Why it's over: `ended` by its server (a cursor's stream ended, or its subject is gone),
   * `stopped` by its reader or the connection's close, or `failed` with the error it threw.
   */
  readonly finished: "ended" | "stopped" | "failed" | undefined
}

type Open<C extends AnyContractRouter, T> = {
  readonly items: AsyncIterator<T>
  readonly session: Session<C>
  readonly cancel: AbortController
}

const done = { value: undefined, done: true } as const

const noop = (): void => {}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const wake = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", wake)
      resolve()
    }
    const timer = setTimeout(wake, ms)
    signal.addEventListener("abort", wake, { once: true })
  })

/** Reports a failure on a closed channel as `DISCONNECTED`, whatever oRPC raised. */
const lost = <C extends AnyContractRouter>(error: unknown, session: Session<C>): unknown => {
  const normalized = normalize(error)
  if (normalized instanceof WireError || session.channel.open) return normalized
  return new WireError("DISCONNECTED", "The connection was lost.", { cause: normalized })
}

const isCursor = <C extends AnyContractRouter, T>(
  resume: CursorResume<C, T> | RestartResume<T>,
): resume is CursorResume<C, T> => !("restart" in resume)

class Follower<C extends AnyContractRouter, T> implements Following<C, T> {
  private stream: Open<C, T> | undefined
  finished: Following<C, T>["finished"]
  private readonly stopping = new AbortController()
  // Whether the stream has yielded on its session, which only then is its.
  private live = false

  // Restarts: the session whose stream ended or was lost, which the next one waits past.
  private spent: Session<C> | undefined
  // Consecutive refusals on a live session, which set the next retry's delay.
  private refusals = 0
  private subscribed = false
  private resetDue = false
  private held: { readonly value: T } | undefined

  // Cursors: where the reader is, in which epoch, and what the server hasn't been told.
  private epoch: string | undefined
  private position: number | undefined
  private read = false
  /** The last item handed out; it counts as read once the next one is asked for. */
  private delivered: number | undefined
  private unacked: number | undefined
  private acking = false

  constructor(
    private readonly wire: Wire<C>,
    private readonly options: FollowOptions<C, T>,
  ) {}

  get session(): Session<C> | undefined {
    return this.live ? this.stream?.session : undefined
  }

  [Symbol.asyncIterator](): this {
    return this
  }

  async next(): Promise<IteratorResult<T, undefined>> {
    const { resume } = this.options
    if (isCursor(resume)) this.ack(resume)
    while (!this.finished) {
      const stream = this.stream
      if (!stream) {
        // eslint-disable-next-line no-await-in-loop -- Open before reading further.
        await this.open()
        continue
      }
      if (this.held) {
        const { value } = this.held
        this.held = undefined
        return { value, done: false }
      }
      if (this.resetDue && !isCursor(resume) && !resume.holdReset) {
        this.resetDue = false
        return { value: resume.reset as T, done: false }
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Items are delivered in order.
        const result = await this.until(stream.items.next())
        if (this.finished || !result) break
        if (result.done) {
          this.ended(stream)
          continue
        }
        return this.deliver(result.value)
      } catch (error) {
        if (this.finished) break
        // eslint-disable-next-line no-await-in-loop -- Back off before opening again.
        await this.failed(lost(error, stream.session), stream.session)
      }
    }
    return done
  }

  return(): Promise<IteratorResult<T, undefined>> {
    this.finish("stopped")
    return Promise.resolve(done)
  }

  /** Waits for `promise`, or resolves undefined once finished. */
  private async until<V>(promise: Promise<V>): Promise<V | undefined> {
    const signal = this.stopping.signal
    if (signal.aborted) return undefined
    // A listener of its own, removed after: a long stream's reads leave nothing behind.
    let stop: () => void = noop
    const stopped = new Promise<undefined>((resolve) => {
      stop = () => resolve(undefined)
    })
    signal.addEventListener("abort", stop, { once: true })
    try {
      return await Promise.race([promise, stopped])
    } finally {
      signal.removeEventListener("abort", stop)
    }
  }

  private deliver(value: T): IteratorResult<T, undefined> {
    const { resume } = this.options
    this.refusals = 0
    this.live = true
    if (isCursor(resume)) {
      this.read = true
      const position = resume.cursor(value)
      if (position !== undefined) {
        this.position = position
        this.delivered = position
      }
      return { value, done: false }
    }
    if (this.resetDue && resume.holdReset) {
      this.resetDue = false
      this.held = { value }
      return { value: resume.reset as T, done: false }
    }
    return { value, done: false }
  }

  /** Opens the stream on the next session it may use; resolves when there's one to read. */
  private async open(): Promise<void> {
    const { resume } = this.options
    const cursor = isCursor(resume)
    let session: Session<C> | undefined
    try {
      // A cursor's first stream opens on the live session or fails: there's nothing to resume.
      session =
        cursor && !this.read
          ? this.wire.session()
          : await this.until(cursor ? this.wire.ready() : this.wire.ready().catch(() => undefined))
    } catch (error) {
      throw this.fail(error)
    }
    if (!session || this.finished) {
      this.finish("stopped")
      return
    }
    if (session === this.spent) {
      await this.until(session.channel.closed)
      return
    }
    if (cursor && session.epoch !== this.epoch) {
      // A cursor belongs to one epoch.
      this.epoch = session.epoch
      this.position = undefined
    }
    const cancel = new AbortController()
    try {
      const after = cursor ? this.position : undefined
      const items = await this.until(
        Promise.resolve(
          this.options.open(session.client, {
            ...(after !== undefined && { after }),
            signal: cancel.signal,
          }),
        ),
      )
      if (this.finished || !items) {
        cancel.abort()
        return
      }
      this.stream = { items: items[Symbol.asyncIterator](), session, cancel }
      this.live = false
      if (!cursor && resume.reset !== undefined) {
        this.resetDue = !resume.holdReset || this.subscribed
      }
      this.subscribed = true
    } catch (error) {
      cancel.abort()
      if (this.finished) return
      await this.failed(lost(error, session), session)
    }
  }

  /** The server ended the stream. */
  private ended(stream: Open<C, T>): void {
    if (isCursor(this.options.resume)) {
      this.finish("ended")
      return
    }
    this.drop()
    // One that can't lose its subject ends as its server goes: wait for the next connection.
    if (!this.options.gone) this.spent = stream.session
  }

  /** Decides what a failure means: open again, now or later, or end with it. */
  private async failed(cause: unknown, session: Session<C>): Promise<void> {
    const { resume, gone } = this.options
    if (isCursor(resume)) {
      // A lost connection resumes after the cursor. A reader too slow for the stream starts
      // afresh, since resuming would bring back the backlog it couldn't keep up with.
      if (this.read && hasCode(cause, "DISCONNECTED", "SLOW_CONSUMER")) {
        if (cause.code === "SLOW_CONSUMER") this.position = undefined
        this.drop()
        return
      }
      throw this.fail(cause)
    }
    if (cause instanceof WireError && gone?.(cause)) {
      this.finish("ended")
      return
    }
    this.drop()
    if (hasCode(cause, "DISCONNECTED", "CLOSING") || !session.channel.open) {
      this.spent = session
      return
    }
    const delay = Math.min(200 * 2 ** this.refusals, 3_000)
    this.refusals += 1
    await sleep(delay, this.stopping.signal)
  }

  /**
   * Acknowledgements are cumulative, so at most one is in flight: later ones replace a waiting
   * position. A refused one is retried, since the server may withhold items until it lands; a
   * lost connection instead ends in a fresh stream with nothing to acknowledge.
   */
  private ack(resume: CursorResume<C, T>): void {
    const stream = this.stream
    if (this.delivered !== undefined) this.unacked = this.delivered
    this.delivered = undefined
    if (this.acking || this.unacked === undefined || !stream) return
    this.acking = true
    void (async () => {
      try {
        while (this.stream === stream && this.unacked !== undefined) {
          const position = this.unacked
          this.unacked = undefined
          try {
            // eslint-disable-next-line no-await-in-loop -- One acknowledgement at a time.
            await resume.ack(stream.session.client, position)
          } catch {
            if (!stream.session.channel.open) return
            this.unacked = Math.max(position, this.unacked ?? position)
            // eslint-disable-next-line no-await-in-loop -- Back off before retrying.
            await sleep(50, stream.cancel.signal)
          }
        }
      } finally {
        this.acking = false
      }
    })()
  }

  private drop(): void {
    this.stream?.cancel.abort()
    this.stream = undefined
    this.delivered = undefined
    this.unacked = undefined
  }

  private fail(error: unknown): unknown {
    this.finish("failed")
    return error
  }

  private finish(reason: NonNullable<Following<C, T>["finished"]>): void {
    this.finished ??= reason
    this.drop()
    this.stopping.abort()
  }
}

/**
 * Follows a stream across a connection's sessions. A stream that resumes from a cursor picks
 * up after the last item read, acknowledging each once the next is asked for, and throws when
 * it can't go on; one that restarts opens again on each new session and never throws, backing
 * off (`min(200·2ⁿ, 3000)` ms) after refusals. Either ends once its reader returns it or the
 * connection closes; a cursor's stream throws why, if it closed with an error.
 *
 * A restarting stream's reader should keep what it has until the stream says `reset`, then
 * replace it with what follows (up to a marker of its own, such as `synced`): the stream
 * repeats the whole state after each `reset`.
 */
export const follow = <C extends AnyContractRouter, T>(
  wire: Wire<C>,
  options: FollowOptions<C, T>,
): Following<C, T> => new Follower(wire, options)
