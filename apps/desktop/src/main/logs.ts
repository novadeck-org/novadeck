import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import type { Data, Log } from "@novadeck/log"
import type { IpcMain, IpcMainEvent } from "electron"

import { openLogsChannel, uiErrorChannel } from "../bridge.js"

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
 * person's `kill -9` both end the runner so, and a kill the host asks for is a slow close's.
 */
export const goneBadly = (reason: string): boolean => reason !== "clean-exit"

/** Calls `line` with each whole line of `stream`, and with what is left once it ends. */
export const eachLine = (
  stream: NodeJS.ReadableStream | null,
  line: (text: string) => void,
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
  })
}

/** How many lines of the runner's output a launch logs, before it says the rest is dropped. */
export const outputLimit = 2_000

/**
 * Logs the runner's output, each line as `runner.stdout` or `runner.stderr`, redacted as
 * every line is; past `limit` lines in a launch, says so once and drops the rest, so a
 * runner that prints without end can't push a crash out of the log.
 */
export const logRunnerOutput = (
  log: Log,
  limit = outputLimit,
): ((run: number, stream: "stdout" | "stderr", line: string) => void) => {
  let count = 0
  return (run, stream, line) => {
    count += 1
    if (count > limit + 1) return
    if (count === limit + 1) {
      log.warn("runner.output-dropped", "The runner wrote more than the log keeps.", {
        data: { run, limit },
      })
      return
    }
    log[stream === "stderr" ? "warn" : "info"](`runner.${stream}`, line, { data: { run } })
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

/** The page's error as an Error, so the log keeps it as it keeps the host's own. */
export const uiErrorAsError = (report: UiError): Error => {
  const error =
    report.name === "SyntaxError" ? new SyntaxError(report.message) : new Error(report.message)
  error.name = report.name
  error.stack = report.stack ?? `${report.name}: ${report.message}`
  return error
}

/**
 * The page asks to open the logs folder, and reports errors it didn't catch, which are
 * logged as the page's (`ui.error`, `ui.rejection`). Only the app's own windows are heard.
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
}
