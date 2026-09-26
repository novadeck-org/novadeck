export type DomainErrorCode =
  | "NOT_FOUND"
  | "INVALID_DIRECTORY"
  | "CONFLICT"
  | "RESOURCE_LIMIT"
  | "TERMINAL_NOT_FOUND"
  | "TERMINAL_EXITED"
  | "CONTROL_IN_USE"
  | "CONTROL_REQUIRED"
  | "ALREADY_ATTACHED"
  | "SLOW_CONSUMER"
  | "SNAPSHOT_TOO_LARGE"
  | "INVALID_CURSOR"
  | "SPAWN_FAILED"
  | "RUNTIME_CLOSING"

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = "DomainError"
  }
}
