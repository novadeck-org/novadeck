import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"
import { inspect } from "node:util"

/** How large the log grows before it is set aside as `<file>.1`, replacing the last one. */
export const updateLogBytes = 1024 * 1024

/** What writing the log uses of the machine; the real one by default. */
export type UpdateLogHost = {
  readonly append: (file: string, text: string) => void
  readonly size: (file: string) => number
  readonly rename: (from: string, to: string) => void
  readonly mkdir: (folder: string) => void
  readonly now: () => Date
}

const machine: UpdateLogHost = {
  append: (file, text) => appendFileSync(file, text),
  size: (file) => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  },
  rename: renameSync,
  mkdir: (folder) => mkdirSync(folder, { recursive: true }),
  now: () => new Date(),
}

// One line of the log: the time, the level and the message, then an error's own text.
const lineOf = (time: Date, level: string, message: unknown, error?: unknown): string => {
  const text = typeof message === "string" ? message : inspect(message, { breakLength: Infinity })
  const reason =
    error === undefined
      ? ""
      : ` ${error instanceof Error ? (error.stack ?? error.message) : inspect(error)}`
  return `${time.toISOString()} ${level} ${text}${reason}`.replaceAll("\n", "\n    ") + "\n"
}

/**
 * The log of updating, in the file `file` names, asked at the first line written: what
 * the host says of checks, downloads and installs, and electron-updater's own messages
 * through `logger`, so a copy that did not update can be asked why. Each line is written
 * at once, synchronously, as the last ones come while the app quits; a write that fails is
 * dropped, as the log must never stop an update. The file is set aside as `<file>.1` once
 * it reaches `updateLogBytes`, so two at most are kept.
 */
export const updateLog = (file: () => string, host: UpdateLogHost = machine) => {
  let path: string | undefined
  const write = (level: string, message: unknown, error?: unknown): void => {
    try {
      path ??= file()
      host.mkdir(dirname(path))
      if (host.size(path) >= updateLogBytes) host.rename(path, `${path}.1`)
      host.append(path, lineOf(host.now(), level, message, error))
    } catch {
      // The log is for diagnosing; updating goes on without it.
    }
  }
  return {
    /** Writes a failure the host reports, with its error. */
    warn: (message: string, error?: unknown): void => write("warn", message, error),
    /** Writes routine progress the host reports. */
    info: (message: string): void => write("info", message),
    /** What electron-updater logs through. */
    logger: {
      info: (message?: unknown): void => write("info", message),
      warn: (message?: unknown): void => write("warn", message),
      error: (message?: unknown): void => write("error", message),
    },
  }
}
