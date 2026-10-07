import type { ErrorCode } from "@novadeck/protocol"

/**
 * The contract's errors a domain operation can raise. Authentication, protocol and
 * call-limit failures belong to the transport and router instead; `RESOURCE_LIMIT` is
 * also a domain's own, for what one connection may hold, such as recordings.
 */
export type DomainErrorCode = Exclude<ErrorCode, "UNAUTHORIZED" | "INCOMPATIBLE_PROTOCOL">

/**
 * Why a `CONFLICT` was raised, for the runner's own callers to tell what may clear by
 * itself from what won't; never sent to a client.
 * - `pending`: a request waits on the person, whose dialog would take the text;
 * - `ringing`: a doorbell ring is under way;
 * - `held`: another hold on the person's input is in force;
 * - `draft`: the input box holds text already;
 * - `no-box`: no input box (or no agent) is found on the screen;
 * - `too-tall`: the text has no room in the box on this screen;
 * - `shell`: the box is in its shell mode;
 * - `no-paste`: the screen takes no bracketed paste.
 */
export type ConflictReason =
  | "pending"
  | "ringing"
  | "held"
  | "draft"
  | "no-box"
  | "too-tall"
  | "shell"
  | "no-paste"

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
    /** What the contract's error carries, such as why voice input is unavailable. */
    readonly data?: unknown,
    /** Why a `CONFLICT` is one, inside the runner only. */
    readonly reason?: ConflictReason,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
