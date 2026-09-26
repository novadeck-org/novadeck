import { ORPCError } from "@orpc/client"

import type { ErrorCode } from "./contract.js"

export type RunnerErrorCode =
  | ErrorCode
  /** The request failed validation. */
  | "BAD_REQUEST"
  /** The connection dropped; nothing was retried. The runner reconnects on its own. */
  | "DISCONNECTED"
  /** The runner client was closed, or its transport cannot connect again. */
  | "CLOSED"
  | "INTERNAL_SERVER_ERROR"

/** Every failure a runner client reports, identified by a stable `code`. */
export class RunnerError extends Error {
  constructor(
    readonly code: RunnerErrorCode,
    message: string = code,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = "RunnerError"
  }
}

/** Converts oRPC failures into runner errors; anything else is a local fault and passes through. */
export const normalize = (error: unknown): unknown =>
  error instanceof ORPCError
    ? new RunnerError(error.code as RunnerErrorCode, error.message, { cause: error })
    : error

export const hasCode = (error: unknown, ...codes: RunnerErrorCode[]): error is RunnerError =>
  error instanceof RunnerError && codes.includes(error.code)
