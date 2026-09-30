import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import { agentSessionId, type AgentName } from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import type { HarnessEvent } from "./events.js"

/** Where a harness lives on this machine, as its setup and inspection need it. */
export type Install = {
  /** The person's login environment, which may move the harness's home. */
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly platform: NodeJS.Platform
  /** NovaDeck's directory holding this harness's plugin files. */
  readonly plugin: string
}

/** One of a harness's plugin commands; a failing one marked `optional` is skipped. */
export type Command = { readonly argv: readonly string[]; readonly optional?: boolean }

/** A file NovaDeck writes for a harness, relative to the directory that holds it. */
export type File = { readonly path: string; readonly content: string; readonly mode?: number }

/**
 * What a hook report says of the session it names: a fresh start, a switch the harness
 * itself announced (resume, /clear…), or only that this conversation is running.
 */
export type Continuity = "startup" | "native-switch" | "conversation-observed"

/**
 * One harness, as its own files and commands describe it. NovaDeck only reads its
 * configuration; installing and removing its plugin goes through its own commands,
 * which own that configuration. A feature it lacks is a field it leaves out.
 */
export type Harness = {
  readonly id: AgentName
  /** Where NovaDeck keeps its plugin, under the plugins directory. */
  readonly plugin: string
  /** Where its installer puts the program when it is not on PATH. */
  readonly fallback?: (home: string) => string
  /** Its own home, whose presence says it is installed. */
  readonly home: (install: Install) => string
  /** Whether its own configuration lists NovaDeck's plugin as installed. */
  readonly connected: (install: Install) => Promise<boolean>
  /** Its plugin commands, run in order. */
  readonly connect: (install: Install) => readonly Command[]
  readonly disconnect: readonly Command[]
  /** The command its plugin runs for a hook `event`, through the harness's own shell. */
  readonly hook: (platform: NodeJS.Platform, event: string) => string
  /** Its plugin's manifests and hook registrations, relative to its plugin directory. */
  readonly files: (platform: NodeJS.Platform) => readonly File[]
  /**
   * Changes its own settings once connected, and puts them back before disconnecting, for
   * what it offers no way to set per launch, as Antigravity's status line.
   */
  readonly settings?: {
    readonly apply: (install: Install) => Promise<void>
    readonly revert: (install: Install) => Promise<void>
  }
  /** Programs NovaDeck's shells put first on PATH while it is connected. */
  readonly shims?: (platform: NodeJS.Platform) => readonly File[]
  /** The words that continue its session by id, which a shell runs as they are. */
  readonly resume?: (session: string) => readonly string[]
  /** The normalized facts in one of its hooks' reports; none for one it ignores. */
  readonly decode: (report: Report) => readonly HarnessEvent[]
  /**
   * Follows a bound session's own sources beyond its hooks, as its transcript, emitting
   * what they say until `signal` aborts.
   */
  readonly watch?: (
    run: Run,
    signal: AbortSignal,
    emit: (event: HarnessEvent) => void,
  ) => Promise<void>
}

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** NovaDeck's plugin, as every harness's manifest names it. */
export const plugin = {
  name: "novadeck",
  version: "1.0.0",
  description: "Tells NovaDeck which session runs in its terminal, so it can resume it.",
}

/** The local marketplace Claude Code and Codex both install NovaDeck's plugin from. */
export const marketplace = json({
  name: "novadeck",
  owner: { name: "NovaDeck" },
  plugins: [{ name: "novadeck", source: "./novadeck", description: plugin.description }],
})

/**
 * A SessionStart `source`: `startup` for a fresh session, anything else (resume, clear,
 * compact) a switch the harness made itself. Without one, only that the conversation runs.
 */
export const sessionStart = (source: string | undefined): Continuity =>
  source === undefined
    ? "conversation-observed"
    : source === "startup"
      ? "startup"
      : "native-switch"

/** A session bound to a terminal, as a harness's `watch` follows it. */
export type Run = {
  readonly sessionId: string
  readonly instance: string | null
  /** Its transcript, as its hooks named it. */
  readonly transcript: string
}

/** A session id a shell can run as a plain word, or undefined. */
export const sessionId = (value: unknown): string | undefined =>
  agentSessionId.safeParse(value).success ? (value as string) : undefined

/** An absolute path here, or undefined. */
export const absolute = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 4096 && !value.includes("\0") && isAbsolute(value)
    ? value
    : undefined

/**
 * An id for the tool call a permission request asks about, which no harness names: the
 * actor that asks (null for the root agent), the tool and a digest of its input, so the
 * call's own result can resolve it.
 */
export const callId = (actor: string | null, toolName: string, input: unknown): string => {
  const digest = createHash("sha256")
    .update(JSON.stringify(input ?? null))
    .digest("hex")
  return `${actor ?? ""}:${toolName}:${digest.slice(0, 16)}`
}

/** A payload's string field, or undefined. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined
