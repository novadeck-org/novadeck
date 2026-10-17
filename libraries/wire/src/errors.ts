import { ORPCError } from "@orpc/client"

/**
 * The failures the wire itself reports to a server's callers, with their HTTP statuses, as
 * an oRPC error map: an app spreads it into its own contract's errors, beside its codes.
 */
export const wireErrors = {
  /** The handshake's token was missing or wrong, or the session never authenticated. */
  UNAUTHORIZED: { status: 401 },
  /** Client and server speak different protocol versions. */
  INCOMPATIBLE_PROTOCOL: { status: 409 },
  /** Too many connections, or too many calls at once on one. */
  RESOURCE_LIMIT: { status: 429 },
  /** The server is shutting down: the call may succeed once it's back. */
  CLOSING: { status: 503 },
  /** A stream's reader fell too far behind; it starts again from scratch. */
  SLOW_CONSUMER: { status: 429 },
  /** A stream can't resume from the cursor given; it starts again from scratch. */
  INVALID_CURSOR: { status: 400 },
} as const

export type WireErrorCode =
  | keyof typeof wireErrors
  /** The request failed validation. */
  | "BAD_REQUEST"
  /** The connection dropped; nothing was retried. */
  | "DISCONNECTED"
  /** The client was closed, or its transport can't connect again. */
  | "CLOSED"
  | "INTERNAL_SERVER_ERROR"

/** A failure a wire client reports, identified by a stable `code`: the wire's or the app's. */
export class WireError<Code extends string = string> extends Error {
  /** What the contract says about this code; unchecked. */
  readonly data: unknown

  constructor(
    readonly code: Code,
    message: string = code,
    options?: ErrorOptions & { readonly data?: unknown },
  ) {
    super(message, options)
    this.name = "WireError"
    this.data = options?.data
  }
}

/** Converts oRPC failures into wire errors; anything else is a local fault and passes through. */
export const normalize = (error: unknown): unknown =>
  error instanceof ORPCError
    ? new WireError(error.code, error.message, { cause: error, data: error.data })
    : error

export const hasCode = <Code extends string>(
  error: unknown,
  ...codes: readonly Code[]
): error is WireError<Code> => error instanceof WireError && codes.includes(error.code as Code)
