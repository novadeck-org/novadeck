import { trimSeparators } from "./redact.js"

/**
 * The schema of a log line. A reader groups lines by `evt` and checks `v` before it trusts
 * any other field; a change that renames or retypes a field raises it.
 */
export const logSchema = 1

const levels = ["debug", "info", "warn", "error", "fatal"] as const

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
type LoggedError = {
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
  /** Which process wrote it, such as `host` (the desktop app's main process). */
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
const stackLimit = 4_000

/** The longest error code a line keeps, in characters. */
const codeLimit = 80

/** `text` cut to `limit` characters, marked where it was cut. */
export const clip = (text: string, limit = textLimit): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/**
 * How much of a text is redacted for a line that keeps `limit` of it: more than `limit`, as
 * redaction can shorten a text (a long key becomes `<secret>`), but not all of a text of any
 * length, which would hold the process for as long as the text is long.
 */
const readLimit = (limit: number): number => Math.max(limit * 4, 8_000)

/**
 * `text` as a line keeps it: redacted, then cut to `limit`. Only its first `readLimit`
 * characters are read, cut where a word ends, so no secret is cut short before it is looked
 * for; a single word longer than that is cut where the reading stops.
 */
export const keep = (text: string, redact: (text: string) => string, limit = textLimit): string => {
  const bound = readLimit(limit)
  if (text.length <= bound) return clip(redact(text), limit)
  let end = bound
  if (!wordEnd.test(text.charAt(bound))) {
    // The word there goes on past the bound: back to where it starts, a step at a time, as a
    // pattern anchored at the end would read a long word again from each of its characters.
    while (end > 0 && !wordEnd.test(text.charAt(end - 1))) end -= 1
    if (end === 0) end = bound
  }
  return clip(`${redact(text.slice(0, end))}…`, limit)
}

/** What ends a word, for `keep`: a space, a quote, or a bracket or separator around it. */
const wordEnd = /[\s"'`,;()[\]{}<>]/

/**
 * What a syntax error may say of where it failed, without the input it quotes: JSON.parse
 * quotes the text it was given (`Unexpected token 'h', "hello" is not valid JSON`), which may
 * be anything, such as a message's body. Everything from the first quote on is dropped.
 */
const withoutQuote = (message: string): string => {
  const quote = message.search(/["'`]/)
  if (quote === -1) return message
  const before = trimSeparators(message.slice(0, quote))
  // Where in the input it failed says nothing of the input.
  const position = /\s(in JSON at position \d+(?: \(line \d+ column \d+\))?)\s*$/.exec(message)?.[1]
  return `${before || "Not valid"} (input withheld${position ? `; ${position}` : ""})`
}

const codeOf = (error: object): string | undefined => {
  const code: unknown = (error as { code?: unknown }).code
  return typeof code === "string" || typeof code === "number" ? String(code) : undefined
}

/**
 * What an error holds under `key`, as text, though code may have set it to anything: undefined
 * where there is none, or where reading it throws, as V8's stack does when it can't make the
 * error's name text.
 */
const textOf = (error: Error, key: "name" | "message" | "stack"): string | undefined => {
  try {
    const value: unknown = error[key]
    return value === undefined || value === null ? undefined : String(value)
  } catch {
    return undefined
  }
}

/**
 * An error as a line keeps it, its text passed through `redact` and cut to size. Anything
 * thrown that is not an Error is kept by its type alone, since its value may be anything.
 */
export const loggedError = (error: unknown, redact: (text: string) => string): LoggedError => {
  if (!(error instanceof Error))
    return { name: typeof error, message: error === undefined ? "" : "A non-Error was thrown" }
  const raw = textOf(error, "message") ?? ""
  const message = error instanceof SyntaxError ? withoutQuote(raw) : raw
  const given = textOf(error, "stack")
  // The stack's first lines repeat the message, quote and all.
  const stack = given && (message === raw ? given : given.replace(raw, message))
  const code = codeOf(error)
  return {
    name: keep(textOf(error, "name") ?? "Error", redact),
    message: keep(message, redact),
    ...(stack && { stack: keep(stack, redact, stackLimit) }),
    ...(code !== undefined && { code: keep(code, redact, codeLimit) }),
  }
}
