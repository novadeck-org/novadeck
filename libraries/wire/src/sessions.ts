import { randomUUID } from "node:crypto"

import { implement, isLazy, ORPCError, os, type AnyRouter } from "@orpc/server"

import { wireErrors } from "./errors.js"
import { wireContract } from "./handshake.js"

/** One client's connection, as the app's handlers see it in their context. */
export type Session = {
  /** This connection's id: what the app keys whatever the session holds by. */
  readonly id: string
  /** The client's id, the same on each of its connections, once its handshake gave it. */
  readonly clientId: string | undefined
  readonly authenticated: boolean
  /** Set once the connection ended or a newer one of its client took over. */
  readonly closed: boolean
}

/** The context every procedure of a sessions' router is called in. */
export type SessionContext = { readonly session: Session }

/** What a transport tells the sessions about one of its connections. */
export type SessionTransport = {
  /** Whether the handshake's token is good. A trusted transport accepts any, even none. */
  readonly verify: (token: string | undefined) => boolean
  /** Ends the transport, as when a newer connection of the same client takes over. */
  readonly terminate: () => void
  /** Tells the transport the session authenticated, as to stop its deadline. */
  readonly authenticated: () => void
  /** Calls the session may have in flight; beyond it, calls fail with `RESOURCE_LIMIT`. */
  readonly maxCalls: number
}

class SessionRecord implements Session {
  readonly id = randomUUID()
  clientId: string | undefined
  authenticated = false
  closed = false
  calls = 0

  constructor(readonly transport: SessionTransport) {}
}

export type SessionsOptions = {
  /** The protocol the server speaks; a client that speaks another is refused. */
  readonly protocolVersion: number
  /** Names this server's lifetime; a fresh id by default. */
  readonly epoch?: string
  /**
   * Called in the handshake once a session proves itself, before it's admitted: throw to
   * refuse it, with an `ORPCError` whose code tells the client why.
   */
  readonly admit?: (session: Session) => void
  /**
   * Called once a session ends, on disconnection or when a newer connection of its client
   * takes over: the app releases what it held.
   */
  readonly closed?: (session: Session) => void
  /** Maps an app's failure to the oRPC error its client sees; others pass through as they are. */
  readonly error?: (error: unknown) => unknown
  /**
   * Told of each failure a client is answered with, by the procedure's path, before it is
   * mapped: a call's, a stream's, and a handshake refused. For a log; what it throws is
   * ignored.
   */
  readonly failed?: (path: readonly string[], error: unknown) => void
}

/** A server's sessions: who's connected, authenticated, and how many calls each has running. */
export type Sessions = {
  readonly epoch: string
  /**
   * The router the transports serve: the wire's handshake, then the app's `router`, each of
   * whose procedures is refused to a session that hasn't authenticated or has closed, and
   * beyond its `maxCalls`. A stream a procedure returns ends when its session closes, and
   * its failures are mapped as a call's are.
   */
  readonly router: AnyRouter
  /** Opens a session for a transport's new connection. */
  open(transport: SessionTransport): Session
  /** Ends a session, once: the app is told it closed. */
  close(session: Session): void
}

const isStream = (value: unknown): value is AsyncIterable<unknown> =>
  typeof value === "object" &&
  value !== null &&
  typeof (value as Partial<AsyncIterable<unknown>>)[Symbol.asyncIterator] === "function"

/** Creates the sessions of one server, which serves the app's `router` to them. */
export const createSessions = (
  options: SessionsOptions & { readonly router: AnyRouter },
): Sessions => {
  const { protocolVersion, admit, error: mapError = (error) => error } = options
  const failed = (path: readonly string[], error: unknown): void => {
    try {
      options.failed?.(path, error)
    } catch {
      // A log that fails changes no answer.
    }
  }
  // The handshake sits beside the app's procedures, which a lazy router would hide it behind.
  if (isLazy(options.router)) throw new Error("The sessions' router can't be lazy")
  if ("wire" in options.router)
    throw new Error("The app's router can't serve the wire's procedures")
  const epoch = options.epoch ?? randomUUID()
  const clients = new Map<string, SessionRecord>()

  const record = (session: Session): SessionRecord => {
    if (!(session instanceof SessionRecord)) throw new Error("Not a session of these sessions.")
    return session
  }

  const close = (session: Session): void => {
    const own = record(session)
    if (own.closed) return
    own.closed = true
    if (own.clientId !== undefined && clients.get(own.clientId) === own)
      clients.delete(own.clientId)
    options.closed?.(own)
  }

  // A client notices a dead link first; end its stale session now instead of after missed
  // heartbeats, so its new one can reclaim what the old held.
  const claim = (session: SessionRecord, clientId: string) => {
    const previous = clients.get(clientId)
    if (previous !== undefined && previous !== session) {
      close(previous)
      previous.transport.terminate()
    }
    session.clientId = clientId
    clients.set(clientId, session)
  }

  // A call refused before it ran: told as a failure, then thrown.
  const refused = (path: readonly string[], error: Error): never => {
    failed(path, error)
    throw error
  }

  // Ends a stream once its session closed, even one that began after, and maps its failures.
  const guard = async function* <T>(
    session: SessionRecord,
    stream: AsyncIterable<T>,
    path: readonly string[],
  ): AsyncGenerator<T> {
    try {
      if (session.closed) {
        // Never read, but told it's done, as one a reader leaves is.
        await stream[Symbol.asyncIterator]().return?.()
        return
      }
      for await (const item of stream) {
        if (session.closed) return
        yield item
      }
    } catch (error) {
      failed(path, error)
      throw mapError(error)
    }
  }

  const gate = os.$context<SessionContext>().middleware(async ({ context, next, path }) => {
    const session = record(context.session)
    if (!session.authenticated || session.closed)
      return refused(
        path,
        new ORPCError("UNAUTHORIZED", { status: wireErrors.UNAUTHORIZED.status }),
      )
    if (session.calls >= session.transport.maxCalls)
      return refused(
        path,
        new ORPCError("RESOURCE_LIMIT", { status: wireErrors.RESOURCE_LIMIT.status }),
      )
    // A stream holds its call only until the procedure hands it back, not while it runs.
    session.calls += 1
    try {
      const result = await next()
      return isStream(result.output)
        ? { ...result, output: guard(session, result.output, path) }
        : result
    } catch (error) {
      failed(path, error)
      throw mapError(error)
    } finally {
      session.calls -= 1
    }
  })

  const api = implement(wireContract).$context<SessionContext>()
  const wire = api.router({
    wire: {
      handshake: api.wire.handshake.handler(({ input, context, errors }) => {
        const session = record(context.session)
        const path = ["wire", "handshake"]
        if (session.closed || !session.transport.verify(input.token))
          refused(path, errors.UNAUTHORIZED())
        if (input.protocolVersion !== protocolVersion) refused(path, errors.INCOMPATIBLE_PROTOCOL())
        admit?.(session)
        session.authenticated = true
        if (input.clientId !== undefined) claim(session, input.clientId)
        session.transport.authenticated()
        return { epoch, protocolVersion }
      }),
    },
  })

  return {
    epoch,
    router: { ...os.$context<SessionContext>().use(gate).router(options.router), ...wire },
    open: (transport) => new SessionRecord(transport),
    close,
  }
}
