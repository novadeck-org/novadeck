import type { WireClient } from "./contract.js"
import { hasCode, normalize, RunnerError } from "./errors.js"
import {
  protocolVersion,
  type Project,
  type TerminalAttached,
  type TerminalEvent,
  type TerminalSummary,
  type WorkspaceSession,
} from "./schemas.js"
import { createWireClient, type Channel } from "./wire.js"

export type RunnerStatus =
  | { readonly state: "connected"; readonly runnerId: string }
  | { readonly state: "reconnecting"; readonly error: RunnerError }
  | { readonly state: "closed"; readonly error?: RunnerError }

/** How a client reaches a runner. See `websocket` and `messagePort`. */
export type Transport = {
  /** Sent in the handshake. Trusted transports omit it. */
  readonly token?: string
  /** Opens one channel. Rejects with `CLOSED` when the transport can never connect again. */
  connect(signal: AbortSignal): Promise<Channel>
}

export type ConnectOptions = {
  /** Cancels the initial connection. Afterwards, use `runner.close()`. */
  readonly signal?: AbortSignal
  /** Milliseconds to wait before reconnection attempt `attempt`, counting from zero. */
  readonly retryDelay?: (attempt: number) => number
  /** Milliseconds a connection may take to open and complete its handshake. */
  readonly timeout?: number
}

export type TerminalMode = "control" | "observe"

/**
 * One attachment to a running terminal. Iterate it for screen events; each event is
 * acknowledged when the next one is requested. The attachment follows the runner
 * through reconnections, resuming after the last event it produced, so a consumer
 * sees one continuous stream. A `snapshot` replaces the screen; it is not appended.
 *
 * Iteration ends when the shell exits or the terminal is detached. It throws a
 * `RunnerError` when the attachment cannot continue, such as `CONTROL_IN_USE` after
 * another client took control during a disconnection.
 */
export type AttachedTerminal = AsyncIterableIterator<TerminalEvent> & {
  readonly id: string
  readonly mode: TerminalMode
  /** Sends input, including control characters. Never retried; success means accepted. */
  write(data: string): Promise<void>
  resize(size: { readonly cols: number; readonly rows: number }): Promise<void>
  /** Ends the shell. The stream then delivers `exited` and finishes. */
  close(): Promise<void>
  /** Releases this attachment and ends iteration. The shell keeps running. */
  detach(): Promise<void>
}

export type Runner = {
  readonly status: RunnerStatus
  /**
   * Yields the current status, then the latest one after each change, until the runner
   * closes. Quick successive changes may be coalesced. `break` stops it at any time.
   */
  watch(): AsyncIterableIterator<RunnerStatus>
  readonly projects: {
    list(): Promise<Project[]>
    create(input: { readonly name: string; readonly cwd: string }): Promise<Project>
    rename(input: { readonly projectId: string; readonly name: string }): Promise<Project>
  }
  readonly sessions: {
    list(input: { readonly projectId: string }): Promise<WorkspaceSession[]>
    create(input: { readonly projectId: string; readonly name: string }): Promise<WorkspaceSession>
    rename(input: { readonly sessionId: string; readonly name: string }): Promise<WorkspaceSession>
  }
  readonly terminals: {
    list(input: { readonly sessionId: string }): Promise<TerminalSummary[]>
    /** Starts a shell in the session's project directory unless `cwd` is given. */
    create(input: {
      readonly sessionId: string
      readonly cwd?: string
      readonly cols: number
      readonly rows: number
    }): Promise<TerminalSummary>
    /** Resolves once the runner has granted the attachment; `control` is the default mode. */
    attach(
      terminalId: string,
      options?: { readonly mode?: TerminalMode },
    ): Promise<AttachedTerminal>
  }
  /** Disconnects. Attached terminals finish; their shells keep running on the runner. */
  close(): Promise<void>
}

type Link = { readonly wire: WireClient; readonly runnerId: string; readonly channel: Channel }

const fatal = ["UNAUTHORIZED", "INCOMPATIBLE_PROTOCOL", "CLOSED"] as const
const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 5_000)

const asRunnerError = (error: unknown): RunnerError => {
  const failure = normalize(error)
  return failure instanceof RunnerError
    ? failure
    : new RunnerError("DISCONNECTED", "Could not connect to the runner.", { cause: failure })
}

/** Reports failures on a closed channel as `DISCONNECTED`, whatever oRPC raised. */
const failure = (error: unknown, link: Link): unknown => {
  const normalized = normalize(error)
  if (normalized instanceof RunnerError || link.channel.open) return normalized
  return new RunnerError("DISCONNECTED", "Runner connection was lost.", { cause: normalized })
}

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

const done = { value: undefined, done: true } as const

/** A value with an async stream of its changes. */
class Watched<T> {
  private wake = () => {}
  private changed = new Promise<void>((resolve) => {
    this.wake = resolve
  })

  constructor(
    private current: T,
    private readonly final: (value: T) => boolean,
  ) {}

  get value(): T {
    return this.current
  }

  set(value: T): void {
    this.current = value
    const wake = this.wake
    this.changed = new Promise((resolve) => {
      this.wake = resolve
    })
    wake()
  }

  /** Resolves on the next change; reading `value` afterwards gives the latest one. */
  next(): Promise<void> {
    return this.changed
  }

  /** Iterates the latest values. Unlike a generator, `return()` also ends a pending wait. */
  watch(): AsyncIterableIterator<T, undefined> {
    let last: { value: T } | undefined
    let stop: (() => void) | undefined
    const stopped = new Promise<typeof done>((resolve) => {
      stop = () => resolve(done)
    })
    let active = true
    const iterator: AsyncIterableIterator<T, undefined> = {
      [Symbol.asyncIterator]: () => iterator,
      next: async () => {
        if (last && this.final(last.value)) active = false
        if (active && last?.value === this.current) {
          await Promise.race([this.changed, stopped])
        }
        if (!active) return done
        last = { value: this.current }
        return { value: this.current, done: false }
      },
      return: () => {
        active = false
        stop?.()
        return Promise.resolve(done)
      },
    }
    return iterator
  }
}

/** Owns the channel to one runner and replaces it after every disconnection. */
class Connection {
  readonly status: Watched<RunnerStatus>

  private readonly stopping = new AbortController()
  // Lets the runner hand this client's terminals over from a connection only it knows is dead.
  private readonly clientId = crypto.randomUUID()
  private readonly retryDelay: (attempt: number) => number
  private readonly timeout: number
  private link: Link | undefined

  constructor(
    private readonly transport: Transport,
    options: ConnectOptions,
  ) {
    this.retryDelay = options.retryDelay ?? backoff
    this.timeout = options.timeout ?? 10_000
    this.status = new Watched<RunnerStatus>(
      { state: "reconnecting", error: new RunnerError("DISCONNECTED", "Not connected yet.") },
      (status) => status.state === "closed",
    )
  }

  /** Makes the first connection; the supervisor then keeps it alive. */
  async open(signal?: AbortSignal): Promise<void> {
    const cancel = () => void this.close()
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      signal?.throwIfAborted()
      this.link = await this.handshake()
    } catch (error) {
      await this.close()
      throw signal?.aborted ? signal.reason : error
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
    this.status.set({ state: "connected", runnerId: this.link.runnerId })
    void this.supervise().catch((error: unknown) => {
      this.link?.channel.close()
      this.status.set({ state: "closed", error: asRunnerError(error) })
    })
  }

  private async handshake(): Promise<Link> {
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(this.timeout)])
    let channel: Channel | undefined
    try {
      channel = await this.transport.connect(signal)
      const wire = createWireClient(channel)
      const token = this.transport.token
      const { runnerId } = await wire.runner.handshake(
        { protocolVersion, clientId: this.clientId, ...(token !== undefined && { token }) },
        { signal },
      )
      return { wire, runnerId, channel }
    } catch (error) {
      channel?.close()
      throw asRunnerError(error)
    }
  }

  /** The live link, for operations that must not wait for a reconnection. */
  current(): Link {
    const status = this.status.value
    if (status.state === "closed") throw status.error ?? new RunnerError("CLOSED")
    if (status.state !== "connected" || !this.link?.channel.open) {
      throw new RunnerError("DISCONNECTED", "Runner is reconnecting.")
    }
    return this.link
  }

  /** Waits for a live link. Resolves `undefined` once the client has been closed. */
  async ready(): Promise<Link | undefined> {
    while (true) {
      const status = this.status.value
      if (status.state === "closed") {
        if (status.error) throw status.error
        return undefined
      }
      if (status.state === "connected" && this.link?.channel.open) return this.link
      // eslint-disable-next-line no-await-in-loop -- Wait for the supervisor to replace the link.
      await this.status.next()
    }
  }

  close(): Promise<void> {
    if (this.status.value.state !== "closed") {
      this.stopping.abort()
      this.link?.channel.close()
      this.status.set({ state: "closed" })
    }
    return Promise.resolve()
  }

  private async supervise(): Promise<void> {
    const signal = this.stopping.signal
    while (this.link) {
      // eslint-disable-next-line no-await-in-loop -- One channel is live at a time.
      await this.link.channel.closed
      if (signal.aborted) return
      let error = new RunnerError("DISCONNECTED", "Runner connection was lost.")
      for (let attempt = 0; ; attempt += 1) {
        this.status.set({ state: "reconnecting", error })
        // eslint-disable-next-line no-await-in-loop -- Back off between attempts.
        await sleep(this.retryDelay(attempt), signal)
        if (signal.aborted) return
        try {
          // eslint-disable-next-line no-await-in-loop -- Attempts are sequential.
          this.link = await this.handshake()
          break
        } catch (reason) {
          if (signal.aborted) return
          error = asRunnerError(reason)
          if (hasCode(error, ...fatal)) {
            this.status.set({ state: "closed", error })
            return
          }
        }
      }
      if (signal.aborted) {
        this.link.channel.close()
        return
      }
      this.status.set({ state: "connected", runnerId: this.link.runnerId })
    }
  }
}

type Stream = AsyncIterator<TerminalAttached | TerminalEvent>

class Attachment implements AttachedTerminal {
  private stream:
    | { readonly events: Stream; readonly link: Link; readonly cancel: AbortController }
    | undefined
  private runnerId: string | undefined
  private cursor: number | undefined
  /** The last event handed out; it counts as consumed once the next one is requested. */
  private delivered: number | undefined
  private unacked: number | undefined
  private acking = false
  private attaching: AbortController | undefined
  private ended: "detached" | "exited" | undefined

  constructor(
    private readonly connection: Connection,
    readonly id: string,
    readonly mode: TerminalMode,
  ) {}

  [Symbol.asyncIterator](): this {
    return this
  }

  /** Attaches on the given link, resuming after the last produced event when possible. */
  async attach(link: Link): Promise<void> {
    if (link.runnerId !== this.runnerId) {
      // A cursor belongs to one runner lifetime.
      this.runnerId = link.runnerId
      this.cursor = undefined
    }
    const cancel = new AbortController()
    this.attaching = cancel
    try {
      const events: Stream = await link.wire.terminals.attach(
        {
          terminalId: this.id,
          mode: this.mode,
          ...(this.cursor !== undefined && { afterSequence: this.cursor }),
        },
        { signal: cancel.signal },
      )
      const first = await events.next()
      if (first.done || first.value.type !== "attached") {
        throw new RunnerError("DISCONNECTED", "Runner ended the attachment before granting it.")
      }
      // Detached while attaching: release what the runner just granted.
      if (this.ended) return cancel.abort()
      this.stream = { events, link, cancel }
      this.delivered = undefined
      this.unacked = undefined
    } catch (error) {
      cancel.abort()
      if (this.ended) return
      throw failure(error, link)
    } finally {
      if (this.attaching === cancel) this.attaching = undefined
    }
  }

  async next(): Promise<IteratorResult<TerminalEvent, undefined>> {
    this.ack()
    while (!this.ended) {
      let link: Link | undefined
      try {
        // eslint-disable-next-line no-await-in-loop -- Reattach before reading further.
        const stream = this.stream ?? (await this.reattach())
        if (!stream) break
        link = stream.link
        // eslint-disable-next-line no-await-in-loop -- Events are delivered in order.
        const result = await stream.events.next()
        if (this.ended) break
        if (result.done) {
          this.end("exited")
          break
        }
        const event = result.value
        if (event.type === "attached") continue
        this.cursor = event.sequence
        this.delivered = event.sequence
        return { value: event, done: false }
      } catch (error) {
        if (this.ended) break
        const cause = link ? failure(error, link) : normalize(error)
        // A lost connection resumes after the cursor. A slow viewer skips its backlog
        // for a fresh snapshot, since replaying it could exceed the budget again.
        if (hasCode(cause, "DISCONNECTED", "SLOW_CONSUMER")) {
          if (cause.code === "SLOW_CONSUMER") this.cursor = undefined
          this.drop()
          continue
        }
        this.end("detached")
        throw cause
      }
    }
    return { value: undefined, done: true }
  }

  async return(): Promise<IteratorResult<TerminalEvent, undefined>> {
    await this.detach()
    return { value: undefined, done: true }
  }

  async write(data: string): Promise<void> {
    const link = this.control()
    try {
      await link.wire.terminals.write({ terminalId: this.id, data })
    } catch (error) {
      throw failure(error, link)
    }
  }

  async resize(size: { readonly cols: number; readonly rows: number }): Promise<void> {
    const link = this.control()
    try {
      await link.wire.terminals.resize({ terminalId: this.id, cols: size.cols, rows: size.rows })
    } catch (error) {
      throw failure(error, link)
    }
  }

  async close(): Promise<void> {
    if (this.ended === "exited") return
    const link = this.control()
    try {
      await link.wire.terminals.close({ terminalId: this.id })
    } catch (error) {
      throw failure(error, link)
    }
  }

  detach(): Promise<void> {
    this.end("detached")
    return Promise.resolve()
  }

  private async reattach(): Promise<Attachment["stream"]> {
    const link = await this.connection.ready()
    if (!link) {
      this.end("detached")
      return undefined
    }
    await this.attach(link)
    return this.stream
  }

  private control(): Link {
    if (this.ended === "exited") throw new RunnerError("TERMINAL_EXITED")
    if (this.ended) throw new RunnerError("CLOSED", "Terminal is detached.")
    if (this.mode !== "control") throw new RunnerError("CONTROL_REQUIRED")
    if (!this.stream?.link.channel.open) {
      throw new RunnerError("DISCONNECTED", "Terminal is reattaching.")
    }
    return this.stream.link
  }

  /**
   * ACKs are cumulative, so at most one is in flight: later ones replace a waiting
   * sequence. A rejected ACK is retried, since the runner withholds events until it
   * lands; a lost connection instead ends in a fresh attachment with a fresh window.
   */
  private ack(): void {
    const stream = this.stream
    if (this.delivered !== undefined) this.unacked = this.delivered
    this.delivered = undefined
    if (this.acking || this.unacked === undefined || !stream) return
    this.acking = true
    void (async () => {
      try {
        while (this.stream === stream && this.unacked !== undefined) {
          const sequence = this.unacked
          this.unacked = undefined
          try {
            // eslint-disable-next-line no-await-in-loop -- One cumulative ACK at a time.
            await stream.link.wire.terminals.ack({ terminalId: this.id, sequence })
          } catch {
            if (!stream.link.channel.open) return
            this.unacked = Math.max(sequence, this.unacked ?? sequence)
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

  private end(reason: "detached" | "exited"): void {
    this.ended ??= reason
    this.attaching?.abort()
    this.drop()
  }
}

/**
 * Connects to a runner and resolves after the first successful handshake. Later
 * disconnections reconnect automatically; `status` and `watch()` report them.
 * Calls made while reconnecting reject with `DISCONNECTED` and are never retried.
 */
export const connectRunner = async (
  transport: Transport,
  options: ConnectOptions = {},
): Promise<Runner> => {
  const connection = new Connection(transport, options)
  await connection.open(options.signal)
  const call = async <T>(operation: (wire: WireClient) => Promise<T>): Promise<T> => {
    const link = connection.current()
    try {
      return await operation(link.wire)
    } catch (error) {
      throw failure(error, link)
    }
  }
  return {
    get status() {
      return connection.status.value
    },
    watch: () => connection.status.watch(),
    projects: {
      list: () => call((wire) => wire.projects.list()),
      create: (input) => call((wire) => wire.projects.create(input)),
      rename: (input) => call((wire) => wire.projects.rename(input)),
    },
    sessions: {
      list: (input) => call((wire) => wire.sessions.list(input)),
      create: (input) => call((wire) => wire.sessions.create(input)),
      rename: (input) => call((wire) => wire.sessions.rename(input)),
    },
    terminals: {
      list: (input) => call((wire) => wire.terminals.list(input)),
      create: (input) => call((wire) => wire.terminals.create(input)),
      async attach(terminalId, { mode = "control" } = {}) {
        const terminal = new Attachment(connection, terminalId, mode)
        await terminal.attach(connection.current())
        return terminal
      },
    },
    close: () => connection.close(),
  }
}
