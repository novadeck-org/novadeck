import { homedir, userInfo } from "node:os"
import { join } from "node:path"

import {
  atLeast,
  consoleEcho,
  createLogger,
  createRedactor,
  loadSalt,
  type Data,
  type Logger,
  type Redactor,
} from "@novadeck/log"

/**
 * What a process of the app needs to write its log, as the main process hands it to the runner in
 * `logArgumentPrefix`'s argument: the logs folder, the launch, which start of the runner
 * this is, and the app's folders the redactor writes as placeholders.
 */
export type LogSetup = {
  readonly folder: string
  readonly sid: string
  readonly run?: number
  /** Whether verbose lines, which may hold what a screen showed, are written. */
  readonly verbose: boolean
  /** The app's folders by placeholder: `userData`, `logs`, `crashDumps`, `install`. */
  readonly places: Readonly<Record<string, string>>
  /** Where the install's salt is kept: beside the app's data, never in the logs. */
  readonly saltFile: string
  /** What a file after a rotation says of the launch first. */
  readonly resume?: Data
}

/** Reads a `LogSetup` the main process wrote; undefined for anything else. */
export const parseLogSetup = (text: string | undefined): LogSetup | undefined => {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as Partial<LogSetup>
    if (
      typeof value.folder !== "string" ||
      typeof value.sid !== "string" ||
      typeof value.saltFile !== "string" ||
      typeof value.places !== "object" ||
      value.places === null
    )
      return undefined
    return {
      folder: value.folder,
      sid: value.sid,
      ...(typeof value.run === "number" && { run: value.run }),
      verbose: value.verbose === true,
      places: Object.fromEntries(
        Object.entries(value.places).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
      saltFile: value.saltFile,
      ...(value.resume && { resume: value.resume }),
    }
  } catch {
    return undefined
  }
}

/**
 * Names that stay readable in any path the app logs, besides the library's well-known ones:
 * the agents and engines the app runs, and the folders they keep.
 */
const appReadableNames: readonly string[] = [
  "claude",
  "codex",
  "agy",
  "antigravity",
  "gemini",
  "llama-server",
  "whisper-cli",
  "novadeck",
  "novadeck-relay",
  ".claude",
  ".codex",
  ".gemini",
  "resources",
  "app.asar",
  "app.asar.unpacked",
]

/**
 * The addresses that stay readable whole: the app's own, its releases, and the services its
 * agents and engines talk to. Any other host name is hashed.
 */
const appReadableUrls: readonly string[] = [
  "novadeck.dev",
  "*.novadeck.dev",
  "github.com/novadeck-org",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
  "api.anthropic.com",
  "api.openai.com",
  "chatgpt.com",
  "registry.npmjs.org",
  "huggingface.co/unsloth",
  "huggingface.co/ggerganov",
  "huggingface.co/ggml-org",
  "storage.googleapis.com/antigravity-public",
]

/** The account's name, if the system will say it. */
const accountName = (): string | undefined => {
  try {
    return userInfo().username
  } catch {
    return undefined
  }
}

/** The app's redactor: what any of its log lines keep of any text. */
const appRedactor = (setup: Pick<LogSetup, "places" | "saltFile">): Redactor => {
  const user = accountName()
  return createRedactor({
    home: homedir(),
    ...(user !== undefined && { user }),
    places: setup.places,
    // Pasted files are kept there under the names they came with.
    ...(setup.places.userData !== undefined && {
      privatePlaces: { uploads: join(setup.places.userData, "uploads") },
    }),
    salt: loadSalt(setup.saltFile),
    readable: appReadableNames,
    readableUrls: appReadableUrls,
    secretNames: ["NOVADECK_TOKEN"],
    secrets: [process.env.NOVADECK_TOKEN],
  })
}

/** Where a launch's salt is kept: in the app's data folder, which a log never names. */
export const saltFileIn = (userData: string): string => join(userData, "log-salt")

/**
 * Opens a process's log: `<proc>.log` in the setup's folder, rotating at 4 MB with 3 kept,
 * redacted for this machine. A development run also shows warnings and errors on the console,
 * as they were shown before there was a log.
 */
export const openProcessLog = (
  proc: "host" | "runner",
  setup: LogSetup,
  options: { readonly echo: boolean },
): Logger =>
  createLogger({
    proc,
    sid: setup.sid,
    ...(setup.run !== undefined && { run: setup.run }),
    file: { folder: setup.folder, name: proc, maxBytes: 4 * 1024 * 1024, keep: 3 },
    redact: appRedactor(setup),
    verbose: setup.verbose,
    ...(setup.resume && { resume: setup.resume }),
    ...(options.echo && {
      echo: (level, text, error) => {
        if (atLeast(level, "warn")) consoleEcho(level, text, error)
      },
    }),
  })
