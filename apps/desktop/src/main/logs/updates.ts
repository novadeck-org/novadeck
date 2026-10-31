// The log of updating, in the app's log.

import { inspect } from "node:util"

import type { Log } from "@novadeck/log"

/** What electron-updater gives its logger, as a line's text, or as the error it is. */
const updaterLine = (message: unknown): { readonly text: string; readonly err?: unknown } =>
  message instanceof Error
    ? { text: "electron-updater reported an error.", err: message }
    : { text: typeof message === "string" ? message : inspect(message, { breakLength: Infinity }) }

/**
 * The log of updating, in the app's log: what the main process says of checks, downloads and
 * installs (`update.progress`, `update.warning`), and electron-updater's own messages through
 * `logger` (`updater.info`, `updater.warning`, `updater.error`), redacted as every line is.
 */
export const updateLogOn = (log: Log) => {
  const updater =
    (level: "info" | "warn" | "error", evt: string) =>
    (message?: unknown): void => {
      const { text, err } = updaterLine(message)
      log[level](evt, text, err === undefined ? {} : { err })
    }
  return {
    /** A failure the main process reports, with its error. */
    warn: (message: string, error?: unknown): void =>
      log.warn("update.warning", message, error === undefined ? {} : { err: error }),
    /** Routine progress the main process reports. */
    info: (message: string): void => log.info("update.progress", message),
    /** What electron-updater logs through. */
    logger: {
      info: updater("info", "updater.info"),
      warn: updater("warn", "updater.warning"),
      error: updater("error", "updater.error"),
    },
  }
}
