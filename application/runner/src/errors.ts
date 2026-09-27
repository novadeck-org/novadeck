import type { ErrorCode } from "@novadeck/protocol"

/**
 * The contract's errors a domain operation can raise. Authentication, protocol and
 * call-limit failures belong to the transport and router instead.
 */
export type DomainErrorCode = Exclude<
  ErrorCode,
  "UNAUTHORIZED" | "INCOMPATIBLE_PROTOCOL" | "RESOURCE_LIMIT"
>

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
