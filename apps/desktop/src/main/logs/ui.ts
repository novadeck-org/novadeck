// What the page asks of the logs: to open the folder, and to log its errors and WebGL counts.

import type { Log } from "@novadeck/log"
import { rendererPoolOf } from "@novadeck/protocol/bridge"
import type { IpcMain, IpcMainEvent } from "electron"

import { openLogsChannel, rendererPoolChannel, uiErrorChannel } from "../../bridge.js"

/** The longest name, message and stack a page's error report may carry. */
const uiLimits = { name: 100, message: 2_000, stack: 8_000 } as const

/** An error the page didn't catch, as it reported it. */
export type UiError = {
  readonly kind: "error" | "rejection"
  readonly name: string
  readonly message: string
  readonly stack?: string
}

/** The page's report when it is one; anything else is dropped. */
export const uiErrorOf = (value: unknown): UiError | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { kind, name, message, stack } = value as Record<string, unknown>
  if (kind !== "error" && kind !== "rejection") return undefined
  if (typeof name !== "string" || typeof message !== "string") return undefined
  return {
    kind,
    name: name.slice(0, uiLimits.name),
    message: message.slice(0, uiLimits.message),
    ...(typeof stack === "string" && { stack: stack.slice(0, uiLimits.stack) }),
  }
}

/** The page's error as an Error, so the log keeps it as it keeps the main process's own. */
const uiErrorAsError = (report: UiError): Error => {
  const error =
    report.name === "SyntaxError" ? new SyntaxError(report.message) : new Error(report.message)
  error.name = report.name
  error.stack = report.stack ?? `${report.name}: ${report.message}`
  return error
}

/**
 * The page asks to open the logs folder, reports errors it didn't catch, which are
 * logged as the page's (`ui.error`, `ui.rejection`), and the counts of its WebGL pool
 * (`ui.renderer-pool`). Only the app's own windows are heard.
 */
export const registerLogIpc = (
  ipc: Pick<IpcMain, "on">,
  options: {
    readonly window: (event: IpcMainEvent) => unknown
    readonly openLogs: () => void
    readonly log: Log
  },
): void => {
  ipc.on(openLogsChannel, (event) => {
    if (options.window(event)) options.openLogs()
  })
  ipc.on(uiErrorChannel, (event, value: unknown) => {
    if (!options.window(event)) return
    const report = uiErrorOf(value)
    if (!report) return
    options.log.error(
      report.kind === "error" ? "ui.error" : "ui.rejection",
      report.kind === "error"
        ? "The page hit an error nothing caught."
        : "A promise in the page failed with nothing to catch it.",
      { err: uiErrorAsError(report) },
    )
  })
  // The last report logged for each page, by its web contents: a window's, until it
  // navigates or closes, which starts its counts afresh.
  const lastPool = new Map<number, string>()
  // The web contents listened to, each once.
  const hooked = new WeakSet<object>()
  ipc.on(rendererPoolChannel, (event, value: unknown) => {
    if (!options.window(event)) return
    const report = rendererPoolOf(value)
    if (!report) return
    const { sender } = event
    // A report the same as the last one from the page says nothing new.
    const text = JSON.stringify(report)
    if (lastPool.get(sender.id) === text) return
    if (!hooked.has(sender)) {
      hooked.add(sender)
      const forget = (): void => void lastPool.delete(sender.id)
      // The main frame committed another page, whose counts begin afresh; a report of the
      // outgoing page can no longer arrive.
      sender.on("did-navigate", forget)
      sender.once("destroyed", forget)
    }
    lastPool.set(sender.id, text)
    options.log.info("ui.renderer-pool", "The page's WebGL pool, counted.", { data: report })
  })
}
