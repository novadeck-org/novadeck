import type { AnyContractRouter, ContractRouterClient } from "@orpc/contract"

import type { Channel } from "./channel.js"
import { hasCode, normalize, WireError } from "./errors.js"
import type { WireContract } from "./handshake.js"
import { sleep } from "./sleep.js"
import type { Transport } from "./transport.js"
import { Watched, type Watching } from "./watched.js"
import { createWireClient } from "./wire-client.js"

/**
 * Where a connection stands. `epoch` names the server's lifetime: it changes when the server
 * restarts, and whatever a client resumes (a stream's cursor) belongs to one epoch.
 */
export type WireStatus =
  | { readonly state: "connected"; readonly epoch: string }
  | { readonly state: "reconnecting"; readonly error: WireError }
  | { readonly state: "closed"; readonly error?: WireError }

/**
 * One live session: a client of contract `C` on one channel, in one epoch, and whether the
 * channel is still open. Only the client speaks on the channel.
 */
export type Session<C extends AnyContractRouter> = {
  readonly client: ContractRouterClient<C>
  readonly epoch: string
  readonly channel: Pick<Channel, "open" | "closed">
}

// The session as the connection holds it, which may close its channel.
type HeldSession<C extends AnyContractRouter> = Session<C> & { readonly channel: Channel }

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

class Connection<C extends AnyContractRouter & WireContract> implements Wire<C> {
  readonly status = new Watched<WireStatus>(
    { state: "reconnecting", error: new WireError("DISCONNECTED", "Not connected yet.") },
    (status) => status.state === "closed",
  )

  private readonly stopping = new AbortController()
  // Lets the server hand this client's state over from a connection only it knows is dead.
  private readonly clientId = crypto.randomUUID()
  private current: HeldSession<C> | undefined

  constructor(private readonly options: ConnectOptions<C>) {}

  /** Makes the first connection; the supervisor then keeps it alive. */
  async open(signal?: AbortSignal): Promise<void> {
    const cancel = () => this.close()
    signal?.addEventListener("abort", cancel, { once: true })
    try {
      signal?.throwIfAborted()
      this.current = await this.handshake()
      // A handshake that ignored the abort may finish after the connection was given up.
      this.stopping.signal.throwIfAborted()
    } catch (error) {
      this.current?.channel.close()
      this.close()
      throw signal?.aborted ? signal.reason : error
    } finally {
      signal?.removeEventListener("abort", cancel)
    }
    this.status.set({ state: "connected", epoch: this.current.epoch })
    void this.supervise().catch((error: unknown) => {
      this.current?.channel.close()
      this.status.set({ state: "closed", error: asWireError(error) })
    })
  }

  private async handshake(): Promise<HeldSession<C>> {
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
    if (status.state !== "connected" || !this.current?.channel.open) {
      throw new WireError("DISCONNECTED", "Reconnecting.")
    }
    return this.current
  }

  async ready(): Promise<Session<C> | undefined> {
    while (true) {
      const status = this.status.value
      if (status.state === "closed") {
        if (status.error) throw status.error
        return undefined
      }
      if (status.state === "connected" && this.current?.channel.open) return this.current
      // eslint-disable-next-line no-await-in-loop -- The supervisor replaces the session.
      await this.status.next()
    }
  }

  close(): void {
    if (this.status.value.state === "closed") return
    this.stopping.abort()
    this.current?.channel.close()
    this.status.set({ state: "closed" })
  }

  private async supervise(): Promise<void> {
    const signal = this.stopping.signal
    const retryDelay = this.options.retryDelay ?? backoff
    while (this.current) {
      // eslint-disable-next-line no-await-in-loop -- One channel is live at a time.
      await this.current.channel.closed
      if (signal.aborted) return
      let error: WireError = new WireError("DISCONNECTED", "The connection was lost.")
      for (let attempt = 0; ; attempt += 1) {
        this.status.set({ state: "reconnecting", error })
        // eslint-disable-next-line no-await-in-loop -- Back off between attempts.
        await sleep(retryDelay(attempt), signal)
        if (signal.aborted) return
        try {
          // eslint-disable-next-line no-await-in-loop -- Attempts are sequential.
          this.current = await this.handshake()
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
        this.current.channel.close()
        return
      }
      this.status.set({ state: "connected", epoch: this.current.epoch })
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
