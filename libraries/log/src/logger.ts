import { collapse, drain, due, type Repeats } from "./collapse.js"
import {
  atLeast,
  clip,
  loggedError,
  logSchema,
  type Data,
  type Entry,
  type Level,
} from "./envelope.js"
import { openLogFile, type LogFile, type LogFileOptions } from "./file.js"
import type { Redactor } from "./redact.js"

/** What a line carries besides its event and message. */
export type Detail = {
  readonly data?: Data
  /** What was thrown, kept as its name, message, stack and code. */
  readonly err?: unknown
  /**
   * Whether the line may hold what a screen showed: written only when verbose logging is on,
   * and marked so an uploader can leave it out.
   */
  readonly verbose?: boolean
}

/** Writes lines for one module. */
export type Log = {
  readonly [L in Level]: (evt: string, msg?: string, detail?: Detail) => void
}

/** A process's log. */
export type Logger = {
  /**
   * The log of the module `src`; of another process than the logger's, `proc`, for lines one
   * process writes for another, as the host writes the page's errors.
   */
  for(src: string, proc?: string): Log
  /** Writes what repeats held back. */
  flush(): void
  /** Writes what repeats held back, then lets go of the file. */
  close(): void
}

export type LoggerOptions = {
  /** The process writing, such as `host` or `runner`. */
  readonly proc: string
  /** The launch's id. */
  readonly sid: string
  /** Which start of the process within the launch, for one started again. */
  readonly run?: number
  /** Where lines go: a rotating file (see `openLogFile`), opened at once. Without one, none are kept. */
  readonly file?: Omit<LogFileOptions, "header">
  /** What every text a line keeps goes through. */
  readonly redact: Redactor
  /** The lowest level written; `info` by default. */
  readonly level?: Level
  /** Whether lines marked verbose are written. */
  readonly verbose?: boolean
  /**
   * What the first line of each file after a rotation says of the launch, such as the app's
   * version and the system, so the file reads without the one before it.
   */
  readonly resume?: Data
  /**
   * Also shows each line, unredacted, as the console of a development run: called with the
   * line's level, its message, and what was thrown, as given.
   */
  readonly echo?: (level: Level, text: string, error?: unknown) => void
  /** How long a line that comes again is held back before its repeats are counted; 0 for never. */
  readonly collapseMs?: number
  readonly now?: () => number
  readonly pid?: number
}

/** The data with its text redacted and cut to size. */
const cleanData = (data: Data, redact: Redactor): Data =>
  Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      typeof value === "string" ? clip(redact(value)) : value,
    ]),
  )

/**
 * A process's log: JSON lines (see `Entry`), every text in them redacted and cut to size,
 * repeats collapsed, written synchronously to a rotating file. Logging never throws.
 */
export const createLogger = (options: LoggerOptions): Logger => {
  const { proc, sid, run, redact, verbose = false, echo } = options
  const threshold = options.level ?? "info"
  const now = options.now ?? Date.now
  const pid = options.pid ?? process.pid
  const windowMs = options.collapseMs ?? 30_000
  let repeats: Repeats = new Map()

  const entry = (
    level: Level,
    from: { readonly src: string; readonly proc: string },
    evt: string,
    msg: string | undefined,
    detail: Detail | undefined,
  ): Entry => ({
    v: logSchema,
    t: new Date(now()).toISOString(),
    level,
    proc: from.proc,
    sid,
    ...(run !== undefined && { run }),
    pid,
    src: from.src,
    evt,
    ...(msg !== undefined && { msg: clip(redact(msg)) }),
    ...(detail?.data && { data: cleanData(detail.data, redact) }),
    ...(detail?.err !== undefined && { err: loggedError(detail.err, redact) }),
    ...(detail?.verbose && { verbose: true as const }),
  })

  const file: LogFile | undefined =
    options.file &&
    openLogFile({
      ...options.file,
      header: () =>
        JSON.stringify(
          entry(
            "info",
            { src: "log", proc },
            "session.resume",
            "Continues the file before this one.",
            {
              ...(options.resume && { data: options.resume }),
            },
          ),
        ),
    })

  const put = (lines: readonly Entry[]): void => {
    for (const line of lines) file?.write(JSON.stringify(line))
  }

  const write = (
    level: Level,
    from: { readonly src: string; readonly proc: string },
    evt: string,
    msg?: string,
    detail?: Detail,
  ): void => {
    try {
      if (!atLeast(level, threshold)) return
      if (detail?.verbose && !verbose) return
      echo?.(level, msg ?? evt, detail?.err)
      const result = collapse(repeats, entry(level, from, evt, msg, detail), now(), windowMs)
      repeats = result.repeats
      put(result.write)
    } catch {
      // Logging never fails what it logs.
    }
  }

  // Repeats are counted out even when nothing else is logged for a while.
  const timer =
    windowMs > 0
      ? setInterval(() => {
          try {
            const result = due(repeats, now(), windowMs)
            repeats = result.repeats
            put(result.write)
          } catch {
            // As above.
          }
        }, windowMs)
      : undefined
  timer?.unref()

  const logs = new Map<string, Log>()
  return {
    for(src, other) {
      const from = { src, proc: other ?? proc }
      const key = `${from.proc} ${src}`
      const known = logs.get(key)
      if (known) return known
      const log: Log = {
        debug: (evt, msg, detail) => write("debug", from, evt, msg, detail),
        info: (evt, msg, detail) => write("info", from, evt, msg, detail),
        warn: (evt, msg, detail) => write("warn", from, evt, msg, detail),
        error: (evt, msg, detail) => write("error", from, evt, msg, detail),
        fatal: (evt, msg, detail) => write("fatal", from, evt, msg, detail),
      }
      logs.set(key, log)
      return log
    },
    flush() {
      try {
        put(drain(repeats))
        repeats = new Map()
      } catch {
        // As above.
      }
    },
    close() {
      this.flush()
      clearInterval(timer)
      file?.close()
    },
  }
}

/**
 * A logger that only shows lines on the console, as `console.warn` and `console.error`, for a
 * process that keeps no log file, such as a runner started on its own or under test; below
 * `warn` nothing is shown.
 */
export const consoleLogger = (): Logger =>
  createLogger({
    proc: "console",
    sid: "",
    redact: (text) => text,
    level: "warn",
    collapseMs: 0,
    echo: consoleEcho,
  })

/** Shows a line on the console the way the code it replaced did: the message, then the error. */
export const consoleEcho = (level: Level, text: string, error?: unknown): void => {
  const show =
    level === "warn"
      ? console.warn
      : level === "info" || level === "debug"
        ? console.log
        : console.error
  if (error === undefined) show(text)
  else show(`${text}:`, error)
}

/**
 * A logger that hands each line to the one it is given last, so modules can take their log
 * when they load and still write to the file a process opens later.
 */
export const switchableLogger = (
  initial: Logger,
): Logger & { use(next: Logger): void; current(): Logger } => {
  let current = initial
  const logs = new Map<string, Log>()
  return {
    use(next) {
      current = next
    },
    current: () => current,
    for(src, proc) {
      const key = `${proc ?? ""} ${src}`
      const known = logs.get(key)
      if (known) return known
      const log: Log = {
        debug: (...args) => current.for(src, proc).debug(...args),
        info: (...args) => current.for(src, proc).info(...args),
        warn: (...args) => current.for(src, proc).warn(...args),
        error: (...args) => current.for(src, proc).error(...args),
        fatal: (...args) => current.for(src, proc).fatal(...args),
      }
      logs.set(key, log)
      return log
    },
    flush: () => current.flush(),
    close: () => current.close(),
  }
}
