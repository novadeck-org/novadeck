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

/** Reports a failure on a closed channel as `DISCONNECTED`, whatever oRPC raised. */
export const lost = (error: unknown, session: Session<typeof contract>): unknown => {
  const normalized = normalize(error)
  if (normalized instanceof WireError || session.channel.open) return normalized
  return new WireError<RunnerErrorCode>("DISCONNECTED", "Runner connection was lost.", {
    cause: normalized,
  })
}
