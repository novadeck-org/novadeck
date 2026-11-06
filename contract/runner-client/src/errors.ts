import type { contract, ErrorCode } from "@novadeck/protocol"
import { hasCode as wireHasCode, normalize, WireError, type WireErrorCode } from "@novadeck/wire"
import { lost as wireLost, type Session } from "@novadeck/wire/client"

/** Every code a runner client reports: the runner's own, and the wire's. */
export type RunnerErrorCode = ErrorCode | WireErrorCode

/** Whether `error` is a wire error with one of the runner's `codes`. */
export const hasCode = (
  error: unknown,
  ...codes: RunnerErrorCode[]
): error is WireError<RunnerErrorCode> => wireHasCode(error, ...codes)

/**
 * A failure as a wire error with a code callers can act on: the runner's or the wire's own as
 * it is, and anything else, such as a reply the client can't read, as `INTERNAL_SERVER_ERROR`
 * with the original as its cause, and its message where it has one.
 */
export const coded = (error: unknown): WireError => {
  const normalized = normalize(error)
  if (normalized instanceof WireError) return normalized
  const message = normalized instanceof Error ? normalized.message : "Runner call failed."
  return new WireError<RunnerErrorCode>("INTERNAL_SERVER_ERROR", message, { cause: normalized })
}

/**
 * A call's failure as wire's `lost` says on a closed channel. On an open one it is `coded`'s
 * instead: what failed is a call, not a stream, and the failure's own message reaches the person.
 */
export const lost = (error: unknown, session: Session<typeof contract>): WireError =>
  session.channel.open ? coded(error) : wireLost(error, session)
