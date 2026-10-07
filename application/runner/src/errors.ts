import type { ErrorCode } from "@novadeck/protocol"

/**
 * The contract's errors a domain operation can raise. Authentication, protocol and
 * call-limit failures belong to the transport and router instead; `RESOURCE_LIMIT` is
 * also a domain's own, for what one connection may hold, such as recordings.
 */
export type DomainErrorCode = Exclude<ErrorCode, "UNAUTHORIZED" | "INCOMPATIBLE_PROTOCOL">

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
    /** What the contract's error carries, such as why voice input is unavailable. */
    readonly data?: unknown,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
