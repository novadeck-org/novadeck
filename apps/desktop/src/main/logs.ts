import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { inspect } from "node:util"

import type { Data, Log } from "@novadeck/log"
import { rendererPoolOf } from "@novadeck/protocol/bridge"
import type { IpcMain, IpcMainEvent } from "electron"

import { openLogsChannel, rendererPoolChannel, uiErrorChannel } from "../bridge.js"

/** How this copy of the app was installed, as a log names it. */
export type InstallKind =
  | "development"
  | "appimage"
  | "linux-package"
  | "linux-unpacked"
  | "mac-applications"
  | "mac-elsewhere"
  | "windows-installer"
  | "windows-portable"

/** How this copy was installed, from what the update plan reads of the build. */
export const installKind = (build: {
  readonly packaged: boolean
  readonly platform: NodeJS.Platform
  readonly appImage: boolean
  readonly execPath: string
  readonly inApplications: boolean
  readonly windowsInstalled: boolean
}): InstallKind => {
  if (!build.packaged) return "development"
  if (build.platform === "darwin")
    return build.inApplications ? "mac-applications" : "mac-elsewhere"
  if (build.platform === "win32")
    return build.windowsInstalled ? "windows-installer" : "windows-portable"
  if (build.appImage) return "appimage"
  // A .deb or .rpm puts the app in /opt; anything else was unpacked by hand.
  return build.execPath.startsWith("/opt/") ? "linux-package" : "linux-unpacked"
}

/** What `child-process-gone` says of a process, as a line's data. */
export const goneData = (details: {
  readonly type: string
  readonly reason: string
  readonly exitCode: number
  readonly serviceName?: string
  readonly name?: string
}): Data => ({
  type: details.type,
  reason: details.reason,
  exitCode: details.exitCode,
  ...(details.serviceName !== undefined && { service: details.serviceName }),
  ...(details.name !== undefined && { name: details.name }),
})

/**
 * Whether a process ended other than cleanly. A kill counts: the system's OOM killer and a
 * person's `kill -9` both end the runner so, and a kill the app asks for is a slow close's.
 */
export const goneBadly = (reason: string): boolean => reason !== "clean-exit"

/**
 * Calls `line` with each whole line of `stream` that holds more than spaces, then `end` once
 * the stream ends, with what was left of it first.
 */
export const eachLine = (
  stream: NodeJS.ReadableStream | null,
  line: (text: string) => void,
  end?: () => void,
): void => {
  if (!stream) return
  let rest = ""
  stream.setEncoding("utf8")
  stream.on("data", (chunk: string) => {
    const lines = (rest + chunk).split(/\r?\n/)
    rest = lines.pop() ?? ""
    for (const each of lines) if (each.trim() !== "") line(each)
  })
  stream.on("end", () => {
    if (rest.trim() !== "") line(rest)
    rest = ""
    end?.()
  })
}

/** How many lines of each stream of each start of the runner are logged. */
const outputLimit = 2_000

/** How many of the lines past the limit are kept, the last ones, to be logged as it ends. */
const outputTail = 100

// The caret Node prints under the source line of an error nothing caught.
const caret = /^\s*\^+\s*$/

/** What the app's main process does with each line the runner writes, and with the end of each stream. */
export type RunnerOutput = {
  readonly line: (run: number, stream: "stdout" | "stderr", text: string) => void
  readonly end: (run: number, stream: "stdout" | "stderr") => void
}

/**
 * Logs the runner's output, each line as `runner.stdout` or `runner.stderr`, redacted as
 * every line is.
 *
 * - The line Node prints above its caret (`^`) for an error nothing caught is the source
 *   it failed in, which may hold anything, as the text a JSON.parse was given: it is
 *   withheld, so each line waits for the next before it is written.
 * - Past `limit` lines of a stream in one start of the runner, it says so once
 *   (`runner.stderr-capped`) and keeps only the last `outputTail` lines, written when the
 *   stream ends (`runner.stderr-tail`): what a runner says as it dies, as V8's report of
 *   running out of memory, comes last. The next start logs afresh.
 */
export const logRunnerOutput = (log: Log, limit = outputLimit): RunnerOutput => {
  type Stream = { count: number; held: string | undefined; tail: string[]; dropped: number }
  const streams = new Map<string, Stream>()
  const of = (run: number, stream: string): Stream => {
    const key = `${run} ${stream}`
    const known = streams.get(key)
    if (known) return known
    const fresh: Stream = { count: 0, held: undefined, tail: [], dropped: 0 }
    streams.set(key, fresh)
    return fresh
  }
  const write = (run: number, stream: "stdout" | "stderr", text: string): void =>
    log[stream === "stderr" ? "warn" : "info"](`runner.${stream}`, text, { data: { run } })
  const emit = (run: number, stream: "stdout" | "stderr", state: Stream, text: string): void => {
    state.count += 1
    if (state.count <= limit) return write(run, stream, text)
    if (state.count === limit + 1)
      log.warn(`runner.${stream}-capped`, "The runner wrote more than the log keeps.", {
        data: { run, limit },
      })
    state.dropped += 1
    state.tail.push(text)
    if (state.tail.length > outputTail) state.tail.shift()
  }
  return {
    line(run, stream, text) {
      const state = of(run, stream)
      const held = state.held
      state.held = text
      if (held === undefined) return
      if (!caret.test(text)) return emit(run, stream, state, held)
      emit(run, stream, state, "(a source line was withheld)")
      state.held = undefined
    },
    end(run, stream) {
      const state = of(run, stream)
      if (state.held !== undefined) emit(run, stream, state, state.held)
      state.held = undefined
      if (state.dropped === 0) return
      log.warn(`runner.${stream}-tail`, "The last lines the runner wrote past the limit.", {
        data: { run, dropped: state.dropped, kept: state.tail.length },
      })
      for (const text of state.tail) write(run, stream, text)
      state.tail = []
      state.dropped = 0
    },
  }
}

/** A crash report Crashpad kept: a minidump, by its name, size and time. */
type Dump = { readonly name: string; readonly size: number; readonly at: string }

/** The minidumps in `folder` and the folders right inside it, where Crashpad keeps them. */
const dumpsIn = (folder: string): Dump[] => {
  const found: Dump[] = []
  const visit = (where: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(where)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(where, name)
      try {
        const stats = statSync(path)
        if (stats.isDirectory() && depth > 0) visit(path, depth - 1)
        else if (stats.isFile() && name.endsWith(".dmp"))
          found.push({ name: basename(path), size: stats.size, at: stats.mtime.toISOString() })
      } catch {
        // Gone since it was listed.
      }
    }
  }
  visit(folder, 2)
  return found
}

/**
 * Logs each crash report Crashpad kept in `folder` that no launch logged before: its name,
 * size and time, never what it holds. Which were logged is kept in `seenFile`.
 */
export const logNewDumps = (folder: string, seenFile: string, log: Log): void => {
  let seen: string[] = []
  try {
    const kept: unknown = JSON.parse(readFileSync(seenFile, "utf8"))
    if (Array.isArray(kept)) seen = kept.filter((name): name is string => typeof name === "string")
  } catch {
    // None logged yet.
  }
  const dumps = dumpsIn(folder)
  const fresh = dumps.filter((dump) => !seen.includes(dump.name))
  for (const dump of fresh)
    log.warn("crash.dump", "A crash report was kept.", {
      data: { name: dump.name, size: dump.size, at: dump.at },
    })
  if (fresh.length === 0) return
  try {
    // Only the dumps still there are remembered, so the file stays as small as the folder.
    writeFileSync(seenFile, JSON.stringify(dumps.map((dump) => dump.name)))
  } catch {
    // Logged again next time.
  }
}

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
