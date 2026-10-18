import { z } from "zod"

// The attach stream both sides speak: what a terminal's viewer receives, and why an attach
// or a call on it fails. A consumer wraps these schemas in its own envelope (an event
// gains the terminal it is of) rather than restating them.

/** A terminal's size, and an event's place in its stream. */
export const columns = z.number().int().min(2).max(500)
export const rows = z.number().int().min(1).max(200)
export const sequence = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

// How a shell ended: its exit code, or the signal that killed it (null on Windows),
// and how long it ran, so a client can tell a quick startup failure from a later exit.
export const exit = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().max(32).nullable(),
  ranMs: z.number().int().nonnegative(),
})

/** Each kind of event, apart, so a consumer can add its envelope's fields to each. */
export const terminalEvents = {
  snapshot: z.strictObject({
    sequence,
    type: z.literal("snapshot"),
    data: z.string(),
    cols: columns,
    rows,
    // Null while the shell runs.
    exit: exit.nullable(),
  }),
  output: z.strictObject({ sequence, type: z.literal("output"), data: z.string() }),
  resized: z.strictObject({ sequence, type: z.literal("resized"), cols: columns, rows }),
  exited: z.strictObject({ sequence, type: z.literal("exited"), exit }),
}

export const terminalEvent = z.discriminatedUnion("type", [
  terminalEvents.snapshot,
  terminalEvents.output,
  terminalEvents.resized,
  terminalEvents.exited,
])

export type Exit = z.infer<typeof exit>
export type TerminalEvent = z.infer<typeof terminalEvent>

/**
 * Why a terminal call fails. `SLOW_CONSUMER` and `INVALID_CURSOR` are a stream's, and
 * name the same failures a transport's resumable streams do.
 */
export const terminalErrorCodes = [
  "TERMINAL_LIMIT",
  "SPAWN_FAILED",
  "INVALID_DIRECTORY",
  "TERMINAL_NOT_FOUND",
  "CLOSING",
  "CONTROL_IN_USE",
  "CONTROL_REQUIRED",
  "ALREADY_ATTACHED",
  "SNAPSHOT_TOO_LARGE",
  "TERMINAL_EXITED",
  "INVALID_CURSOR",
  "SLOW_CONSUMER",
] as const

export type TerminalErrorCode = (typeof terminalErrorCodes)[number]

/** A terminal call's failure, by its code; its consumer maps the code to its own errors. */
export class TerminalError extends Error {
  constructor(
    readonly code: TerminalErrorCode,
    message: string = code,
  ) {
    super(message)
    this.name = "TerminalError"
  }
}

/**
 * One attached stream, as a client holds it: its events as it reads them, acknowledging
 * each as it asks for the next, and the terminal's input and size while it holds control.
 */
export type AttachStream = AsyncIterable<TerminalEvent> & {
  readonly mode: "control" | "observe"
  /** Control only. */
  write(data: string): Promise<void>
  /** Control only; a success after a reconnect shows the stream is live. */
  resize(cols: number, rows: number): Promise<void>
  close(): void
}
