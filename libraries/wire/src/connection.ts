import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract"

import type { Channel } from "./channel.js"
import { hasCode, normalize, WireError } from "./errors.js"
import type { WireContract } from "./handshake.js"
import { createWireClient, type Transport } from "./transport.js"

/**
 * Where a connection stands. `epoch` names the server's lifetime: it changes when the server
 * restarts, and whatever a client resumes (a stream's cursor) belongs to one epoch.
 */
export type WireStatus =
  | { readonly state: "connected"; readonly epoch: string }
  | { readonly state: "reconnecting"; readonly error: WireError }
  | { readonly state: "closed"; readonly error?: WireError }

/**
 * One live connection: a client of contract `C`, in one epoch, and whether its channel is
 * still open. Only the client speaks on the channel.
 */
export type Session<C extends AnyContractRouter> = {
  readonly client: ContractRouterClient<C>
  readonly epoch: string
  readonly channel: Pick<Channel, "open" | "closed">
}

type Link<C extends AnyContractRouter> = Session<C> & { readonly channel: Channel }

export type ConnectOptions<C extends AnyContractRouter & WireContract> = {
  /** The contract the server serves, for the client's types: the app's, with the wire's. */
  readonly contract: C
  readonly transport: Transport
  /** The protocol the client speaks; a server that speaks another refuses it. */
  readonly protocolVersion: number
  /**
   * Codes that end the connection for good, beside the wire's own (`UNAUTHORIZED`,
   * `INCOMPATIBLE_PROTOCOL`, `CLOSED`): no reconnection would succeed.
   */
  readonly fatal?: (code: string) => boolean
  /** Milliseconds to wait before reconnection attempt `attempt`, counting from zero. */
  readonly retryDelay?: (attempt: number) => number
  /**
   * Milliseconds a connection may take to open and complete its handshake. The transport is
   * told through its signal, and must give up when it aborts.
   */
  readonly timeoutMs?: number
  /** Cancels the first connection. Afterwards, use `close()`. */
  readonly signal?: AbortSignal
}

/** A `Watched` value as its readers see it: they can't set it. */
export type Watching<T> = Pick<Watched<T>, "value" | "next" | "watch">

/** A supervised connection: it replaces its channel after every disconnection. */
export type Wire<C extends AnyContractRouter> = {
  readonly status: Watching<WireStatus>
  /**
   * The live session, for calls that must not wait for a reconnection. Throws
   * `DISCONNECTED` while reconnecting, and the closing error once closed.
   */
  session(): Session<C>
  /** Waits for a live session. Resolves `undefined` once closed, or throws why it closed. */
  ready(): Promise<Session<C> | undefined>
  /** Disconnects for good. */
  close(): void
}

const wireFatal = ["UNAUTHORIZED", "INCOMPATIBLE_PROTOCOL", "CLOSED"] as const
const backoff = (attempt: number) => Math.min(250 * 2 ** attempt, 5_000)

/** A connection's failure as a wire error; anything that isn't one is a failure to connect. */
const asWireError = (error: unknown): WireError => {
  const failure = normalize(error)
  return failure instanceof WireError
    ? failure
    : new WireError("DISCONNECTED", "Could not connect.", { cause: failure })
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
export class Watched<T> {
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

  /**
   * Iterates the latest values, ending after a final one. Quick successive changes may be
   * coalesced. Unlike a generator, `return()` also ends a pending wait.
   */
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

class Connection<C extends AnyContractRouter & WireContract> implements Wire<C> {
  readonly status = new Watched<WireStatus>(
    { state: "reconnecting", error: new WireError("DISCONNECTED", "Not connected yet.") },
    (status) => status.state === "closed",
  )

  private readonly stopping = new AbortController()
  // Lets the server hand this client's state over from a connection only it knows is dead.
  private readonly clientId = crypto.randomUUID()
  private link: Link<C> | undefined

  constructor(private readonly options: ConnectOptions<C>) {}

  /** Makes the first connection; the supervisor then keeps it alive. */
  async open(signal?: AbortSignal): Promise<void> {
    const cancel = () => this.close()
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      signal?.throwIfAborted()
      this.link = await this.handshake()
      // A handshake that ignored the abort may finish after the connection was given up.
      this.stopping.signal.throwIfAborted()
    } catch (error) {
      this.link?.channel.close()
      this.close()
      throw signal?.aborted ? signal.reason : error
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
    this.status.set({ state: "connected", epoch: this.link.epoch })
    void this.supervise().catch((error: unknown) => {
      this.link?.channel.close()
      this.status.set({ state: "closed", error: asWireError(error) })
    })
  }

  private async handshake(): Promise<Link<C>> {
    const { transport, timeoutMs = 10_000 } = this.options
    const signal = AbortSignal.any([this.stopping.signal, AbortSignal.timeout(timeoutMs)])
    let channel: Channel | undefined
    try {
      channel = await transport.connect(signal)
      const client = createWireClient<C>(channel)
      const { protocolVersion } = this.options
      // Every contract a connection serves has the wire's handshake.
      const wire = (client as unknown as ContractRouterClient<WireContract>).wire
      const opened = await wire.handshake(
        {
          protocolVersion,
          clientId: this.clientId,
          ...(transport.token !== undefined && { token: transport.token }),
        },
        { signal },
      )
      if (opened.protocolVersion !== protocolVersion) {
        throw new WireError("INCOMPATIBLE_PROTOCOL", "The server speaks another protocol.")
      }
      return { client, epoch: opened.epoch, channel }
    } catch (error) {
      channel?.close()
      throw asWireError(error)
    }
  }

  private fatal(error: WireError): boolean {
    return hasCode(error, ...wireFatal) || (this.options.fatal?.(error.code) ?? false)
  }

  session(): Session<C> {
    const status = this.status.value
    if (status.state === "closed") throw status.error ?? new WireError("CLOSED")
    if (status.state !== "connected" || !this.link?.channel.open) {
      throw new WireError("DISCONNECTED", "Reconnecting.")
    }
    return this.link
  }

  async ready(): Promise<Session<C> | undefined> {
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

  close(): void {
    if (this.status.value.state === "closed") return
    this.stopping.abort()
    this.link?.channel.close()
    this.status.set({ state: "closed" })
  }

  private async supervise(): Promise<void> {
    const signal = this.stopping.signal
    const retryDelay = this.options.retryDelay ?? backoff
    while (this.link) {
      // eslint-disable-next-line no-await-in-loop -- One channel is live at a time.
      await this.link.channel.closed
      if (signal.aborted) return
      let error: WireError = new WireError("DISCONNECTED", "The connection was lost.")
      for (let attempt = 0; ; attempt += 1) {
        this.status.set({ state: "reconnecting", error })
        // eslint-disable-next-line no-await-in-loop -- Back off between attempts.
        await sleep(retryDelay(attempt), signal)
        if (signal.aborted) return
        try {
          // eslint-disable-next-line no-await-in-loop -- Attempts are sequential.
          this.link = await this.handshake()
          break
        } catch (reason) {
          if (signal.aborted) return
          error = asWireError(reason)
          if (this.fatal(error)) {
            this.status.set({ state: "closed", error })
            return
          }
        }
      }
      if (signal.aborted) {
        this.link.channel.close()
        return
      }
      this.status.set({ state: "connected", epoch: this.link.epoch })
    }
  }
}

/**
 * Connects, resolving after the first handshake. Later disconnections reconnect on their
 * own, backing off, until a fatal code or `close()`; `status` reports each step.
 */
export const connect = async <C extends AnyContractRouter & WireContract>(
  options: ConnectOptions<C>,
): Promise<Wire<C>> => {
  const connection = new Connection(options)
  await connection.open(options.signal)
  return connection
}
