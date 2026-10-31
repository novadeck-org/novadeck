import type { Install, Model } from "@novadeck/harness-core/harness"
import type { AgentName } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import { withLocale } from "@novadeck/terminal/shell"

import type { CompanionItems } from "../companions/items.js"
import type { ApprovingOptions } from "./approving.js"
import type { TerminalOptions } from "./manager.js"
import type { TerminalRecords } from "./saved-terminals.js"

export const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Terminal limits must be positive integers.")
  return result
}

/** What the terminals' options come to once defaulted and checked. */
export type Settings = Required<
  Omit<
    TerminalOptions,
    | "env"
    | "baseEnv"
    | "shellArgs"
    | "shellFiles"
    | "records"
    | "handleOrder"
    | "shims"
    | "connected"
    | "transcripts"
    | "transcriptMs"
    | "transcriptShutdownMs"
    | "redactor"
    | "sealer"
    | "transcriptKeyMs"
    | "projectFolder"
    | "messages"
    | "inbox"
    | "projectOf"
    | "doorbell"
    | "prompts"
    | "interrupts"
    | "answers"
    | "install"
    | "models"
    | "hooksTrusted"
    | "items"
    | "describer"
    | "murmurTimes"
    | "pty"
    | keyof ApprovingOptions
  >
> & {
  env: NodeJS.ProcessEnv
  shellArgs: readonly string[] | undefined
  records: TerminalRecords | undefined
  projectFolder: ((sessionId: string) => string | undefined) | undefined
  projectOf: ((sessionId: string) => string | undefined) | undefined
  shims: () => Promise<readonly AgentName[]>
  connected: (agent: AgentName) => Promise<boolean>
  install: (agent: AgentName) => Promise<Install | undefined>
  models: (agent: AgentName) => Promise<readonly Model[]>
  hooksTrusted: ((agent: AgentName, cwd: string) => Promise<boolean | undefined>) | undefined
  items: CompanionItems | undefined
}

/** The options of `Terminals` with their defaults, the limits checked. */
export const settingsOf = (options: TerminalOptions): Settings => {
  return {
    shell:
      options.shell ??
      (process.platform === "win32"
        ? (process.env.COMSPEC ?? "cmd.exe")
        : (process.env.SHELL ?? "/bin/sh")),
    shellArgs: options.shellArgs,
    env: withLocale({
      ...(options.baseEnv ?? process.env),
      ...options.env,
      TERM: "xterm-256color",
    }),
    freshPath: options.freshPath ?? options.baseEnv === undefined,
    maxTerminals:
      options.maxTerminals === undefined
        ? Number.POSITIVE_INFINITY
        : positive(options.maxTerminals, 1),
    maxRetained: positive(options.maxRetained, 32),
    historyBytes: positive(options.historyBytes, 1024 * 1024),
    subscriberBytes: positive(options.subscriberBytes, 4 * 1024 * 1024),
    snapshotBytes: positive(options.snapshotBytes, 32 * 1024 * 1024),
    ackWindowBytes: positive(options.ackWindowBytes, 256 * 1024),
    processPollMs: positive(options.processPollMs, 1000),
    records: options.records,
    shims: options.shims ?? (() => Promise.resolve([])),
    connected: options.connected ?? (() => Promise.resolve(true)),
    saveMs: positive(options.saveMs, 5000),
    transcriptChars: positive(options.transcriptChars, 256 * 1024),
    projectFolder: options.projectFolder,
    projectOf: options.projectOf,
    openMs: positive(options.openMs, 6_000),
    install: options.install ?? (() => Promise.resolve(undefined)),
    models: options.models ?? (() => Promise.resolve([])),
    hooksTrusted: options.hooksTrusted,
    items: options.items,
    platform: options.platform ?? process.platform,
    relay: options.relay ?? relayPath,
  }
}
