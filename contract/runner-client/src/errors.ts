import type { contract, ErrorCode } from "@novadeck/protocol"
import { hasCode as wireHasCode, normalize, WireError, type WireErrorCode } from "@novadeck/wire"
import type { Session } from "@novadeck/wire/client"

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
 * with the original as its cause.
 */
export const coded = (error: unknown): WireError => {
  const normalized = normalize(error)
  if (normalized instanceof WireError) return normalized
  return new WireError<RunnerErrorCode>("INTERNAL_SERVER_ERROR", "Runner call failed.", {
    cause: normalized,
  })
}

/** A call's failure as `coded` says, except that one on a closed channel is `DISCONNECTED`. */
export const lost = (error: unknown, session: Session<typeof contract>): WireError => {
  const normalized = normalize(error)
  if (normalized instanceof WireError || session.channel.open) return coded(normalized)
  return new WireError<RunnerErrorCode>("DISCONNECTED", "Runner connection was lost.", {
    cause: normalized,
  })
}
