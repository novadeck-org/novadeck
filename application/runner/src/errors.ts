import type { conflictReason, ErrorCode } from "@novadeck/protocol"
import type { z } from "zod"

/**
 * The contract's errors a domain operation can raise. Authentication, protocol and
 * call-limit failures belong to the transport and router instead; `RESOURCE_LIMIT` is
 * also a domain's own, for what one connection may hold, such as recordings.
 */
export type DomainErrorCode = Exclude<ErrorCode, "UNAUTHORIZED" | "INCOMPATIBLE_PROTOCOL">

/**
 * Why a `CONFLICT` about typing into an agent's terminal was raised, which the router
 * sends as its data (see the protocol's `conflictReason`).
 */
export type ConflictReason = z.infer<typeof conflictReason>["reason"]

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
    /** What the contract's error carries, such as why voice input is unavailable. */
    readonly data?: unknown,
    /** Why a `CONFLICT` is one, sent as its data where `data` gives none. */
    readonly reason?: ConflictReason,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
