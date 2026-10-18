import type { ErrorCode } from "@novadeck/protocol"
import { hasCode as wireHasCode, type WireError, type WireErrorCode } from "@novadeck/wire"

/** Every code a runner client reports: the runner's own, and the wire's. */
export type RunnerErrorCode = ErrorCode | WireErrorCode

/** Whether `error` is a wire error with one of the runner's `codes`. */
export const hasCode = (
  error: unknown,
  ...codes: RunnerErrorCode[]
): error is WireError<RunnerErrorCode> => wireHasCode(error, ...codes)
