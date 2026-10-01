import type { WireClient } from "./contract.js"
import { hasCode, normalize, RunnerError } from "./errors.js"
import {
  protocolVersion,
  type AgentDetail,
  type AgentIntegration,
  type AgentName,
  type Project,
  type RunnerSettings,
  type TerminalAttached,
  type TerminalChange,
  type TerminalEvent,
  type TerminalMessages,
  type TerminalRequest,
  type TerminalRequestAnswer,
  type TerminalSummary,
  type PlanContent,
  type AgentShown,
  type ArtifactContent,
  type TranscriptChange,
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
 * An item of `runner.terminals.watch()`: a runner change, or `reset`, which the client
 * yields before each fresh `changed`…`synced` sequence.
 */
export type TerminalWatchItem = TerminalChange | { readonly type: "reset" }

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
    /**
     * The client names the project with a fresh UUID; a taken one rejects with
     * `CONFLICT`. Without `cwd`, the project opens in the runner owner's home directory.
     */
    create(input: {
      readonly id: string
      readonly name: string
      readonly cwd?: string
    }): Promise<Project>
    rename(input: { readonly projectId: string; readonly name: string }): Promise<Project>
  }
  readonly sessions: {
    list(input: { readonly projectId: string }): Promise<WorkspaceSession[]>
    /** The client names the session with a fresh UUID; a taken one rejects with `CONFLICT`. */
    create(input: {
      readonly id: string
      readonly projectId: string
      readonly name: string
    }): Promise<WorkspaceSession>
    rename(input: { readonly sessionId: string; readonly name: string }): Promise<WorkspaceSession>
    /** Replaces the session's `state`, which the runner stores without reading. */
    save(input: { readonly sessionId: string; readonly state: string }): Promise<void>
  }
  readonly terminals: {
    list(input: { readonly sessionId: string }): Promise<TerminalSummary[]>
    /**
     * Starts a shell in the session's project directory unless `cwd` is given. The
     * client names the terminal with a fresh UUID; a taken one, even by an exited
     * terminal the runner still retains, rejects with `CONFLICT`.
     */
    create(input: {
      readonly id: string
      readonly sessionId: string
      readonly cwd?: string
      readonly cols: number
      readonly rows: number
      /**
       * Starts where the runner's saved record of this terminal left off: in its last
       * directory, with its saved transcript shown before the shell's output.
       */
      readonly restore?: boolean
      /**
       * The agent that ran there: while it is connected, the runner resumes the session
       * it last reported in this terminal, and shows no transcript.
       */
      readonly resume?: AgentName
      /**
       * Runs once at the shell's first prompt, as if typed there; never with `restore` or
       * `resume`. A shell that can't run one rejects with `SPAWN_FAILED`.
       */
      readonly command?: string
      /**
       * Its title; a restored terminal keeps its saved one, and a new one takes the
       * session's next default, when left out.
       */
      readonly title?: string
    }): Promise<TerminalSummary>
    /**
     * Follows agents' requests for a new terminal, made through NovaDeck's MCP server,
     * across reconnections. The runner sends each to the client that subscribed last and
     * waits a few seconds for `answerRequest`; iteration ends when the runner closes or on
     * `return()`.
     */
    requests(): AsyncIterableIterator<TerminalRequest, undefined>
    /**
     * Answers a request with the terminal this client opened for it, or why it didn't.
     * Rejects with `NOT_FOUND` once the runner no longer waits for it.
     */
    answerRequest(answer: TerminalRequestAnswer): Promise<void>
    /**
     * Follows every terminal on the runner, across sessions. Each subscription, the
     * first and every one after a reconnection or a retried refusal, yields `reset`,
     * then `changed` for each terminal, then `synced`. On `reset`, clear the set of
     * reported terminals; at `synced`, forget any terminal not reported since, for
     * example one that ended with a restarted runner. Later events report creation,
     * foreground process, size and exit changes, and `removed` for closed or evicted
     * records. Quick successive changes of one terminal may be coalesced. Refusals such
     * as `RESOURCE_LIMIT` are retried with a growing delay; iteration ends only when
     * the runner closes or on `return()`.
     */
    watch(): AsyncIterableIterator<TerminalWatchItem, undefined>
    /**
     * Ends the shell and, once it has exited, removes the terminal: `list` omits it and
     * watchers see `removed`. Needs no attachment, but rejects with `CONTROL_IN_USE`
     * while another connection controls the terminal.
     */
    close(terminalId: string): Promise<void>
    /**
     * Renames a terminal; the runner keeps the title and `watch` reports it. Rejects with
     * `TERMINAL_NOT_FOUND` for a terminal the runner keeps nothing of.
     */
    rename(terminalId: string, title: string): Promise<void>
    /**
     * Starts a fresh shell in an exited terminal the runner still holds, keeping its id,
     * session and directory, and gives this client control. Attach again for the new
     * screen. Rejects with `CONFLICT` while it runs and `SPAWN_FAILED` when the shell
     * cannot start, which leaves it exited.
     */
    restart(
      terminalId: string,
      size: { readonly cols: number; readonly rows: number; readonly resume?: AgentName },
    ): Promise<TerminalSummary>
    /** Resolves once the runner has granted the attachment; `control` is the default mode. */
    attach(
      terminalId: string,
      options?: { readonly mode?: TerminalMode },
    ): Promise<AttachedTerminal>
  }
  readonly agents: {
    list(): Promise<AgentIntegration[]>
    /**
     * Follows what the agent in a terminal does, in detail: a snapshot, then another on
     * each change, across reconnections, each subscription starting with a fresh one. It
     * follows the terminal from agent to agent; iteration ends once the terminal is gone,
     * when the runner closes, or on `return()`.
     */
    detail(terminalId: string): AsyncIterableIterator<AgentDetail, undefined>
    /**
     * Follows an actor's conversation, by the ref `detail` names it by: every item its
     * harness recorded, then each later one. After a reconnection the items follow again
     * from the start, after a `reset`. Iteration ends once the terminal's agent has left
     * the actor's session, the actor or its transcript is not found, the runner closes,
     * or on `return()`.
     */
    transcript(
      terminalId: string,
      actor: string,
    ): AsyncIterableIterator<TranscriptChange, undefined>
    /**
     * Follows a plan `detail` lists, by its ref: its text as it stands, then again on each
     * change, across reconnections. Iteration ends once another plan replaces it, the
     * terminal's agent leaves its session, the runner closes, or on `return()`.
     */
    plan(terminalId: string, plan: string): AsyncIterableIterator<PlanContent, undefined>
    /**
     * Follows what the terminal's agents showed the user through NovaDeck's MCP server:
     * a snapshot, then another on each change, across reconnections. Iteration ends once
     * the terminal is gone, the runner closes, or on `return()`.
     */
    shown(terminalId: string): AsyncIterableIterator<AgentShown, undefined>
    /** One thing `shown` lists, as captured; NOT_FOUND once it no longer lists it. */
    artifact(terminalId: string, artifact: string): Promise<ArtifactContent>
    /**
     * Installs or removes NovaDeck's plugin in the agent through its own commands;
     * rejects with `AGENT_SETUP_FAILED` saying why when that did not work.
     */
    set(agent: AgentName, connected: boolean): Promise<AgentIntegration>
  }
  readonly messages: {
    /** A terminal's threads and messages with their states; `TERMINAL_NOT_FOUND` when unknown. */
    list(terminalId: string): Promise<TerminalMessages>
    /**
     * Pauses messaging across the whole runner, every project and session, or resumes it;
     * the runner keeps the switch.
     */
    pause(paused: boolean): Promise<void>
    /** Releases a held thread: its messages go on, and it may have 12 more. */
    release(thread: string): Promise<void>
  }
  readonly settings: {
    get(): Promise<RunnerSettings>
    /** Changes the settings given; the others stay. */
    set(settings: Partial<RunnerSettings>): Promise<void>
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
 * `agents.detail()`, `agents.transcript()` and the like: one subscription per connection, renewed
 * after each reconnection or when the runner ends it, until what it follows is no longer
 * found. Each new subscription starts over; `fresh`, where given, says so first.
 */
class Resubscription<T> implements AsyncIterableIterator<T, undefined> {
  private stream:
    | {
        readonly items: AsyncIterator<T>
        readonly link: Link
        readonly cancel: AbortController
      }
    | undefined
  /** The link whose subscription failed; the next one waits for a different link. */
  private spent: Link | undefined
  private refusals = 0
  private ended = false
  private stop = () => {}
  private readonly stopped = new Promise<undefined>((resolve) => {
    this.stop = () => resolve(undefined)
  })

  /** Whether the next item is the start of a new subscription, after the first. */
  private started = false
  /** The first item of a new subscription, held back behind `fresh`. */
  private held: T | undefined
  private subscribed = false

  constructor(
    private readonly connection: Connection,
    private readonly open: (wire: WireClient, signal: AbortSignal) => Promise<AsyncIterator<T>>,
    private readonly fresh?: T,
  ) {}

  [Symbol.asyncIterator](): this {
    return this
  }

  /** Never throws: failures resubscribe, and iteration ends once the terminal is gone. */
  async next(): Promise<IteratorResult<T, undefined>> {
    while (!this.ended) {
      const stream = this.stream
      if (!stream) {
        // eslint-disable-next-line no-await-in-loop -- Subscribe before reading further.
        if (!(await this.subscribe())) break
        continue
      }
      if (this.held !== undefined) {
        const value = this.held
        this.held = undefined
        return { value, done: false }
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Snapshots are delivered in order.
        const result = await Promise.race([stream.items.next(), this.stopped])
        if (this.ended || !result) break
        if (!result.done) {
          this.refusals = 0
          // A new subscription says it starts over only once it has something to follow,
          // so one that finds nothing does not wipe what came before.
          if (this.started && this.fresh !== undefined) {
            this.started = false
            this.held = result.value
            return { value: this.fresh, done: false }
          }
          this.started = false
          return { value: result.value, done: false }
        }
        // The terminal closed, or the runner is shutting down: a new subscription tells.
        this.drop()
      } catch (error) {
        if (this.ended) break
        // eslint-disable-next-line no-await-in-loop -- Back off before resubscribing.
        await this.recover(failure(error, stream.link), stream.link)
      }
    }
    return done
  }

  return(): Promise<IteratorResult<T, undefined>> {
    this.end()
    return Promise.resolve(done)
  }

  private async subscribe(): Promise<boolean> {
    const link = await Promise.race([this.connection.ready().catch(() => undefined), this.stopped])
    if (!link || this.ended) {
      this.end()
      return false
    }
    if (link === this.spent) {
      await Promise.race([link.channel.closed, this.stopped])
      return true
    }
    const cancel = new AbortController()
    try {
      const items = await this.open(link.wire, cancel.signal)
      if (this.ended) cancel.abort()
      else {
        this.stream = { items, link, cancel }
        // The first subscription needs no word that it starts over.
        this.started = this.subscribed
        this.subscribed = true
      }
    } catch (error) {
      cancel.abort()
      await this.recover(failure(error, link), link)
    }
    return !this.ended
  }

  /**
   * What it follows no longer found ends iteration. A lost connection is followed to the next
   * one; any other failure is retried after a growing delay.
   */
  private async recover(cause: unknown, link: Link): Promise<void> {
    if (hasCode(cause, "TERMINAL_NOT_FOUND", "NOT_FOUND")) {
      this.end()
      return
    }
    this.drop()
    if (hasCode(cause, "DISCONNECTED", "RUNTIME_CLOSING") || !link.channel.open) {
      this.spent = link
      return
    }
    const delay = Math.min(200 * 2 ** this.refusals, 3_000)
    this.refusals += 1
    await Promise.race([new Promise((resolve) => setTimeout(resolve, delay)), this.stopped])
  }

  private drop(): void {
    this.stream?.cancel.abort()
    this.stream = undefined
  }

  private end(): void {
    this.ended = true
    this.drop()
    this.stop()
  }
}

/** `terminals.watch()`: one subscription per connection, renewed after each reconnection. */
class TerminalWatch implements AsyncIterableIterator<TerminalWatchItem, undefined> {
  private stream:
    | {
        readonly changes: AsyncIterator<TerminalChange>
        readonly link: Link
        readonly cancel: AbortController
      }
    | undefined
  /** The link whose subscription ended; the next one waits for a different link. */
  private spent: Link | undefined
  /** Set by each new subscription, whose sequence opens with `reset`. */
  private fresh = false
  /** Consecutive refusals on a live link, which set the next retry's delay. */
  private refusals = 0
  private ended = false
  private stop = () => {}
  private readonly stopped = new Promise<undefined>((resolve) => {
    this.stop = () => resolve(undefined)
  })

  constructor(private readonly connection: Connection) {}

  [Symbol.asyncIterator](): this {
    return this
  }

  /** Never throws: failures resubscribe, and iteration ends only on close or `return()`. */
  async next(): Promise<IteratorResult<TerminalWatchItem, undefined>> {
    while (!this.ended) {
      const stream = this.stream
      if (!stream) {
        // eslint-disable-next-line no-await-in-loop -- Subscribe before reading further.
        if (!(await this.subscribe())) break
        continue
      }
      if (this.fresh) {
        this.fresh = false
        return { value: { type: "reset" }, done: false }
      }
      try {
        // eslint-disable-next-line no-await-in-loop -- Changes are delivered in order.
        const result = await Promise.race([stream.changes.next(), this.stopped])
        if (this.ended || !result) break
        if (!result.done) {
          this.refusals = 0
          return { value: result.value, done: false }
        }
        // The runner ended the stream, as when it shuts down; follow its next connection.
        this.drop(true)
      } catch (error) {
        if (this.ended) break
        // eslint-disable-next-line no-await-in-loop -- Back off before resubscribing.
        await this.recover(failure(error, stream.link), stream.link)
      }
    }
    return done
  }

  return(): Promise<IteratorResult<TerminalWatchItem, undefined>> {
    this.end()
    return Promise.resolve(done)
  }

  /** Subscribes on the next live link; resolves false once the runner has closed. */
  private async subscribe(): Promise<boolean> {
    const link = await Promise.race([this.connection.ready().catch(() => undefined), this.stopped])
    if (!link || this.ended) {
      this.end()
      return false
    }
    if (link === this.spent) {
      await Promise.race([link.channel.closed, this.stopped])
      return true
    }
    const cancel = new AbortController()
    try {
      const changes = await link.wire.terminals.watch(undefined, { signal: cancel.signal })
      if (this.ended) cancel.abort()
      else {
        this.stream = { changes, link, cancel }
        this.fresh = true
      }
    } catch (error) {
      cancel.abort()
      await this.recover(failure(error, link), link)
    }
    return !this.ended
  }

  /**
   * A lost or closing connection is followed to the next one. Any other failure on a
   * live link, such as `RESOURCE_LIMIT`, is retried there after a growing delay.
   */
  private async recover(cause: unknown, link: Link): Promise<void> {
    const lost = hasCode(cause, "DISCONNECTED", "RUNTIME_CLOSING") || !link.channel.open
    if (lost) {
      this.spent = link
      this.drop(true)
      return
    }
    this.drop(false)
    const delay = Math.min(200 * 2 ** this.refusals, 3_000)
    this.refusals += 1
    await Promise.race([new Promise((resolve) => setTimeout(resolve, delay)), this.stopped])
  }

  private drop(spent: boolean): void {
    if (spent) this.spent = this.stream?.link ?? this.spent
    this.stream?.cancel.abort()
    this.stream = undefined
  }

  private end(): void {
    this.ended = true
    this.drop(true)
    this.stop()
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
      save: (input) => call((wire) => wire.sessions.save(input)),
    },
    terminals: {
      list: (input) => call((wire) => wire.terminals.list(input)),
      create: (input) => call((wire) => wire.terminals.create(input)),
      requests: () =>
        new Resubscription(connection, (wire, signal) =>
          wire.terminals.requests(undefined, { signal }),
        ),
      answerRequest: (answer) => call((wire) => wire.terminals.answerRequest(answer)),
      watch: () => new TerminalWatch(connection),
      close: (terminalId) => call((wire) => wire.terminals.close({ terminalId })),
      rename: (terminalId, title) => call((wire) => wire.terminals.rename({ terminalId, title })),
      restart: (terminalId, { cols, rows, resume }) =>
        call((wire) =>
          wire.terminals.restart({ terminalId, cols, rows, ...(resume ? { resume } : {}) }),
        ),
      async attach(terminalId, { mode = "control" } = {}) {
        const terminal = new Attachment(connection, terminalId, mode)
        await terminal.attach(connection.current())
        return terminal
      },
    },
    agents: {
      list: () => call((wire) => wire.agents.list()),
      detail: (terminalId) =>
        new Resubscription(connection, (wire, signal) =>
          wire.agents.detail({ terminalId }, { signal }),
        ),
      transcript: (terminalId, actor) =>
        new Resubscription<TranscriptChange>(
          connection,
          (wire, signal) => wire.agents.transcript({ terminalId, actor }, { signal }),
          { type: "reset" },
        ),
      plan: (terminalId, plan) =>
        new Resubscription(connection, (wire, signal) =>
          wire.agents.plan({ terminalId, plan }, { signal }),
        ),
      shown: (terminalId) =>
        new Resubscription(connection, (wire, signal) =>
          wire.agents.shown({ terminalId }, { signal }),
        ),
      artifact: (terminalId, artifact) =>
        call((wire) => wire.agents.artifact({ terminalId, artifact })),
      set: (agent, connected) => call((wire) => wire.agents.set({ agent, connected })),
    },
    messages: {
      list: (terminalId) => call((wire) => wire.messages.list({ terminalId })),
      pause: (paused) => call((wire) => wire.messages.pause({ paused })),
      release: (thread) => call((wire) => wire.messages.release({ thread })),
    },
    settings: {
      get: () => call((wire) => wire.settings.get()),
      set: (settings) => call((wire) => wire.settings.set(settings)),
    },
    close: () => connection.close(),
  }
}
