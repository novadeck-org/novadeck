import type { AgentName } from "@novadeck/protocol"

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
  /** The command its plugin's hook runs, through the harness's own shell. */
  readonly hook: (platform: NodeJS.Platform) => string
  /** Its plugin's manifests and hook registrations, relative to its plugin directory. */
  readonly files: (platform: NodeJS.Platform) => readonly File[]
  /** Programs NovaDeck's shells put first on PATH while it is connected. */
  readonly shims?: (platform: NodeJS.Platform) => readonly File[]
  /** The words that continue its session by id, which a shell runs as they are. */
  readonly resume?: (session: string) => readonly string[]
  /** What a hook report's `source` says of the session it names. */
  readonly continuity: (source: string | undefined) => Continuity
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
