/**
 * The schema of a log line. A reader groups lines by `evt` and checks `v` before it trusts
 * any other field; a change that renames or retypes a field raises it.
 */
export const logSchema = 1

export const levels = ["debug", "info", "warn", "error", "fatal"] as const

export type Level = (typeof levels)[number]

/** Whether a line at `level` is written where `threshold` is the lowest one kept. */
export const atLeast = (level: Level, threshold: Level): boolean =>
  levels.indexOf(level) >= levels.indexOf(threshold)

/**
 * The typed facts a line carries: flat, and only strings, numbers, booleans and null, so no
 * object is ever dumped into a log whole.
 */
export type Data = Readonly<Record<string, string | number | boolean | null>>

/** An error as a line keeps it. */
export type LoggedError = {
  readonly name: string
  readonly message: string
  readonly stack?: string
  readonly code?: string
}

/** One line of a log, as JSON. */
export type Entry = {
  /** The schema version, `logSchema`. */
  readonly v: number
  /** When, as an ISO time in UTC. */
  readonly t: string
  readonly level: Level
  /** Which process wrote it, such as `host`. */
  readonly proc: string
  /** The launch it belongs to: one random id per start of the app, never kept across launches. */
  readonly sid: string
  /** Which start of its process within the launch, for a process that is started again. */
  readonly run?: number
  readonly pid: number
  /** The module that wrote it. */
  readonly src: string
  /** A stable, dotted event name, such as `runner.exit`. */
  readonly evt: string
  /** A sentence for a person to read. */
  readonly msg?: string
  readonly data?: Data
  readonly err?: LoggedError
  /** Set on lines only verbose logging writes, which may hold what a screen showed. */
  readonly verbose?: true
}

/** The longest message, error message or data text a line keeps, in characters. */
export const textLimit = 500

/** The longest stack a line keeps, in characters. */
export const stackLimit = 4_000

/** `text` cut to `limit` characters, marked where it was cut. */
export const clip = (text: string, limit = textLimit): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/**
 * `text` passed through `redact`, then cut to `limit` characters. Only its first `limit` × 4
 * characters are read: what lies past them would be cut anyway, and redacting a line of any
 * length would hold up the process that logs it.
 */
export const cleaned = (
  text: string,
  redact: (text: string) => string,
  limit = textLimit,
): string => {
  const read = text.slice(0, limit * 4)
  return clip(redact(read) + (read.length < text.length ? "…" : ""), limit)
}

/**
 * What a syntax error may say of where it failed, without the input it quotes: JSON.parse
 * quotes the text it was given (`Unexpected token 'h', "hello" is not valid JSON`), which may
 * be anything, such as a message's body. Everything from the first quote on is dropped.
 */
export const withoutQuote = (message: string): string => {
  const quote = message.search(/["'`]/)
  if (quote === -1) return message
  const before = message.slice(0, quote).replace(/[\s,:]+$/, "")
  // Where in the input it failed says nothing of the input.
  const position = /\s(in JSON at position \d+(?: \(line \d+ column \d+\))?)\s*$/.exec(message)?.[1]
  return `${before || "Not valid"} (input withheld${position ? `; ${position}` : ""})`
}

const codeOf = (error: object): string | undefined => {
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined
}

/**
 * An error as a line keeps it, its text passed through `redact` and cut to size. Anything
 * thrown that is not an Error is kept by its type alone, since its value may be anything.
 */
export const loggedError = (error: unknown, redact: (text: string) => string): LoggedError => {
  if (!(error instanceof Error))
    return { name: typeof error, message: error === undefined ? "" : "A non-Error was thrown" }
  const raw = error.message
  const message = error instanceof SyntaxError ? withoutQuote(raw) : raw
  // The stack's first lines repeat the message, quote and all.
  const stack = error.stack && (message === raw ? error.stack : error.stack.replace(raw, message))
  const code = codeOf(error)
  return {
    name: cleaned(error.name, redact),
    message: cleaned(message, redact),
    ...(stack && { stack: cleaned(stack, redact, stackLimit) }),
    ...(code !== undefined && { code: cleaned(code, redact, 80) }),
  }
}
