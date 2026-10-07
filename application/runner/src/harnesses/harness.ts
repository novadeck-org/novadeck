import { createHash } from "node:crypto"
import { isAbsolute } from "node:path"

import {
  agentSessionId,
  replyPreviewLength,
  type AgentCoverage,
  type AgentName,
  type TranscriptItem,
} from "@novadeck/protocol"

import type { Report } from "../shell/reports.js"
import type { BoxProfile } from "./box.js"
import type { DialogAdapter } from "./dialogs.js"
import type { HarnessEvent, PlanSource, PromptShown } from "./events.js"

/** Where a harness lives on this machine, as its setup and inspection need it. */
export type Install = {
  /** The person's login environment, which may move the harness's home. */
  readonly env: NodeJS.ProcessEnv
  readonly home: string
  readonly platform: NodeJS.Platform
  /** Novadeck's directory holding this harness's plugin files. */
  readonly plugin: string
}

/** One of a harness's plugin commands; a failing one marked `optional` is skipped. */
export type Command = { readonly argv: readonly string[]; readonly optional?: boolean }

/** A file Novadeck writes for a harness, relative to the directory that holds it. */
export type File = { readonly path: string; readonly content: string; readonly mode?: number }

/**
 * What a hook report says of the session it names: a fresh start, a switch the harness
 * itself announced (resume, /clear…), or only that this conversation is running.
 */
export type Continuity = "startup" | "native-switch" | "conversation-observed"

/**
 * One harness, as its own files and commands describe it. Novadeck only reads its
 * configuration; installing and removing its plugin goes through its own commands,
 * which own that configuration. A feature it lacks is a field it leaves out.
 */
export type Harness = {
  readonly id: AgentName
  /** Where Novadeck keeps its plugin, under the plugins directory. */
  readonly plugin: string
  /** Where its installer puts the program when it is not on PATH. */
  readonly fallback?: (home: string) => string
  /** Its own home, whose presence says it is installed. */
  readonly home: (install: Install) => string
  /** Whether its own configuration lists Novadeck's plugin as installed. */
  readonly connected: (install: Install) => Promise<boolean>
  /** Its plugin commands, run in order. */
  readonly connect: (install: Install) => readonly Command[]
  readonly disconnect: readonly Command[]
  /** The command its plugin runs for a hook `event`, through the harness's own shell. */
  readonly hook: (platform: NodeJS.Platform, event: string) => string
  /**
   * Its plugin's manifests, hook registrations and MCP server, relative to its plugin
   * directory. The MCP server starts as `mcpServer` says.
   */
  readonly files: (platform: NodeJS.Platform, launchers: Launchers) => readonly File[]
  /**
   * Changes its own settings once connected, and puts them back before disconnecting, for
   * what it offers no way to set per launch, as Antigravity's status line.
   */
  readonly settings?: {
    readonly apply: (install: Install) => Promise<void>
    readonly revert: (install: Install) => Promise<void>
  }
  /** Programs Novadeck's shells put first on PATH while it is connected. */
  readonly shims?: (platform: NodeJS.Platform) => readonly File[]
  /** The words that continue its session by id, which a shell runs as they are. */
  readonly resume?: (session: string) => readonly string[]
  /** Where its actors' transcripts are, and what each of their records says. */
  readonly transcripts?: {
    /**
     * The transcript of a session's root, or of one of its subagents by its own id, given
     * the root's; undefined when it cannot be found.
     */
    readonly locate: (
      root: string,
      sessionId: string,
      subagent: string | null,
    ) => Promise<string | undefined>
    /** The items one line of it records, oldest first; none for a line of anything else. */
    readonly items: (line: string) => readonly TranscriptEntry[]
  }
  /**
   * The plans one line of its transcript or rollout records, as its own decoders read
   * them, each with when it was written: how a plan it presented as text, which no file
   * of its own holds, is read back once its hooks and activity are gone.
   */
  readonly plans?: (line: string) => readonly WrittenPlan[]
  /** How much of each feature Novadeck tells of it, from the sources its adapter reads. */
  readonly coverage: AgentCoverage
  /**
   * Whether work a turn leaves running, as a background subagent or command, wakes the
   * agent with a turn of its own once done, so it works on until then (see
   * docs/harness-coverage.md, "Activity").
   */
  readonly wakes: boolean
  /** How it takes part in agents' messaging: what its hooks print, and how it behaves. */
  readonly messaging: MessagingProfile
  /** How its input box reads off its screen, which a prompt checks before and after it pastes. */
  readonly box: BoxProfile
  /** The normalized facts in one of its hooks' reports; none for one it ignores. */
  readonly decode: (report: Report) => readonly HarnessEvent[]
  /**
   * How its TUI's dialogs for requests waiting on the person read on screen and take an
   * answer, so the chat can answer them (see `dialogs.ts`); absent where none can be.
   */
  readonly dialogs?: DialogAdapter
  /**
   * Whether one of its hooks' reports says its prompt shows before any session it names
   * has bound, as Antigravity's status line saying idle with no conversation yet.
   */
  readonly shown?: (report: Report) => PromptShown | undefined
  /**
   * Whether the terminal title it sets, as Novadeck's shells start it (Codex's shim names
   * the title's items), says its prompt shows. It counts only while the terminal's
   * foreground runs a process of the harness's name.
   */
  readonly title?: (title: string, at: number) => PromptShown | undefined
  /** Whether the terminal title it sets says a turn runs, as Codex's Working does. */
  readonly titleWorking?: (title: string) => boolean
  /**
   * Whether Novadeck's hooks run for it in `cwd`, where it runs them only once the person
   * trusts them (Codex): a prompt it shows counts only then, as nothing could deliver a
   * message, or confirm a ring, without them. `where` holds the terminal's own program
   * and environment where the runner can tell them. Undefined when the harness couldn't
   * answer; trusted when omitted.
   */
  readonly hooksTrusted?: (
    where: Install & { readonly program?: string },
    cwd: string,
  ) => Promise<boolean | undefined>
  /**
   * Whether the session a title shows, whose id starts with `prefix`, is one it just
   * started as a new root (Codex's /clear), not another it only shows, as a forked side
   * conversation or a spawned agent: only then does a title naming another session end
   * the bound one's binding. `holds` tells whether a process of the terminal's
   * foreground group, where the harness runs, holds a file open, where the platform
   * tells. Where omitted, nothing but the session's own hooks ends it.
   */
  readonly startedSession?: (
    where: Install,
    prefix: string,
    since: number,
    holds?: (path: string) => Promise<boolean | undefined>,
  ) => Promise<boolean>
  /**
   * The variables of its process that say where it lives and which program it runs (as
   * Codex's `CODEX_HOME`), read from the terminal's own process where the platform tells,
   * for asking it about its hooks and sessions.
   */
  readonly environment?: readonly string[]
  /**
   * Follows a bound session's own sources beyond its hooks, as its transcript, emitting
   * what they say until `signal` aborts.
   */
  readonly watch?: (
    run: Run,
    signal: AbortSignal,
    emit: (event: HarnessEvent) => void,
  ) => Promise<void>
  /**
   * Follows one of a bound session's subagents, by its id, in its own sources, for what
   * ends its turn that no hook reports, as Codex's rollout records a request dismissed
   * with Esc: from `since`, when its oldest request still waiting was asked, until
   * `signal` aborts. Novadeck follows it only while that subagent's request waits.
   */
  readonly watchActor?: (
    run: Run,
    actor: string,
    since: number,
    signal: AbortSignal,
    emit: (event: HarnessEvent) => void,
  ) => Promise<void>
}

/**
 * What a harness knows of agents' messaging (see docs/agent-messaging.md): what its hooks
 * print when they ask Novadeck, each a whole line of the JSON it reads, and how it
 * behaves, so shared code never asks which harness it is. Nothing here says how it draws
 * its screen: the doorbell's checks are the same for every TUI.
 */
export type MessagingProfile = {
  /** The hook events that ask, and when each fires: as a turn ends, or as a prompt starts it. */
  readonly asks: { readonly [event: string]: "stop" | "prompt" }
  /**
   * What a hook prints with nothing to deliver, as it does without Novadeck: by event, and
   * for any other (`*`). The relay prints the same when Novadeck can't answer.
   */
  readonly silent: { readonly "*": string; readonly [event: string]: string }
  /** A Stop's answer that continues the turn with a delivery. */
  readonly stop: (delivery: string) => string
  /** A prompt's answer that adds a delivery to what the model sees, apart from the prompt. */
  readonly prompt: (delivery: string) => string
  /**
   * Whether a prompt-time delivery lasts only for the model call it was printed for, so
   * each later call of the turn gets it again, as in Antigravity.
   */
  readonly reinjectPerCall: boolean
  /**
   * Which session its messages are for: the one bound (`binding`), or, where its hooks
   * name subagents' sessions alike, the one its status line names (`status-line`).
   */
  readonly root: "binding" | "status-line"
  /** The key that queues the person's prompt for after the turn, as Codex's Tab. */
  readonly queueKey?: string
  /** Whether a failed turn fires nothing, so its turn may only end with its next prompt. */
  readonly silentOnFailure: boolean
  /**
   * How it starts with `line` as its first prompt, which it submits only once past its
   * startup screens; undefined where it may not here, as Antigravity in a folder it
   * doesn't trust yet, whose trust dialog its prompt doesn't wait for.
   */
  readonly initialPrompt: (
    line: string,
    place: { readonly install: Install | undefined; readonly cwd: string },
  ) => Promise<readonly string[] | undefined>
  /** How it starts without a prompt. */
  readonly start: readonly string[]
  /**
   * Where its hooks name no prompt (as Antigravity's, whose every turn decodes as
   * harness-started), what one line of its transcript records as typed into its box, if
   * that is what it records: from it `typed-prompts.ts` tells a root turn's prompt.
   */
  readonly typedEntry?: (line: string) => UserEntry | undefined
}

/**
 * Something a transcript recorded as typed into the agent's box: its text; when, rounded
 * down where the transcript is coarser (Antigravity's is to the second); and its place in
 * the transcript (`id`, growing with each step), where the transcript gives one.
 */
export type UserEntry = {
  readonly text: string
  readonly at: number | null
  readonly id: number | null
}

/**
 * How long a harness lets one of Novadeck's hooks run, in seconds; one slower is dropped
 * silently. Well above the hook's own limit, so the hook always ends by itself.
 */
export const hookSeconds = 10

export const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** Where the plugin's commands start from, as Novadeck wrote them for this run. */
/** What `profile`'s hook prints for `event` with nothing to deliver. */
export const silentFor = (profile: MessagingProfile, event: string): string =>
  profile.silent[event] ?? profile.silent["*"]

/** How an agent starts a program of Novadeck's: a file, by its absolute path, and arguments. */
export type Start = { readonly command: string; readonly args?: readonly string[] }

/**
 * How agents start what Novadeck installs for them: its MCP server, which they start
 * without a shell that could expand a variable.
 */
export type Launchers = { readonly mcp: Start }

/** How an agent starts Novadeck's MCP server, as its plugin names it. */
export const mcpServer = (launchers: Launchers): Start => launchers.mcp

/** The terminal's variables Novadeck's MCP server is started and finds its runner by. */
export const mcpVariables = [
  "NOVADECK_MCP",
  "NOVADECK_TERMINAL_ID",
  "NOVADECK_REPORT",
  "NOVADECK_REPORT_TOKEN",
] as const

/** Novadeck's plugin, as every harness's manifest names it. */
export const plugin = {
  name: "novadeck",
  version: "1.2.0",
  description:
    "Tells Novadeck which session runs in its terminal, so it can resume it, lets the agent show you files beside it, and lets agents in Novadeck message each other.",
}

/** The local marketplace Claude Code and Codex both install Novadeck's plugin from. */
export const marketplace = json({
  name: "novadeck",
  owner: { name: "Novadeck" },
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
/** A plan a transcript or rollout line records, and when it was written where it says. */
export type WrittenPlan = { readonly source: PlanSource; readonly at: number | null }

/** An item of a transcript, before the runner numbers it. */
export type TranscriptEntry = Omit<TranscriptItem, "index">

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
 * Each request among `events` with the directory its hook named, where it named an
 * absolute one, so a dialog's relative paths resolve where that agent runs.
 */
export const withRequestCwd = (
  events: readonly HarnessEvent[],
  payload: { readonly cwd?: unknown },
): readonly HarnessEvent[] => {
  const cwd = absolute(payload.cwd)
  if (!cwd) return events
  return events.map((event) =>
    event.type === "attention-requested" && event.cwd === undefined ? { ...event, cwd } : event,
  )
}

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

/** The line Novadeck's doorbell types, with its nonce (see docs/agent-messaging.md). */
export const doorbellLine = (nonce: string): string =>
  `[Novadeck: automatic notice, agent messages waiting, ${nonce}]`

/** Any doorbell line, wherever it is. */
export const doorbell = /\[Novadeck: automatic notice, agent messages waiting, ([A-Za-z0-9]+)\]/g

/** The nonce of a prompt that is exactly a doorbell line, as typed or started with; else undefined. */
export const doorbellNonce = (prompt: string): string | undefined =>
  /^\[Novadeck: automatic notice, agent messages waiting, ([A-Za-z0-9]+)\]$/.exec(
    prompt.trim(),
  )?.[1]

/**
 * The person's prompt without any doorbell line left in it, as a line a failed ring left
 * in the box that they then submitted with their own text.
 */
export const withoutDoorbell = (prompt: string): string =>
  prompt
    .replace(doorbell, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim()

/**
 * Whether a prompt is a hook's rather than the person's: a Stop hook's reason the harness
 * submits as a prompt (Codex wraps it in `<hook_prompt>`), or a delivery of agents'
 * messages. A doorbell prompt is told apart by `doorbellNonce`.
 */
export const continuationPrompt = (prompt: string): boolean =>
  /^\s*<hook_prompt\b/.test(prompt) || prompt.includes("<novadeck-messages")

/**
 * The turn a root prompt starts, from its text: Novadeck's doorbell, a hook's
 * continuation (or `harness` by the harness's own reckoning), or a prompt with the
 * person's text, any doorbell line removed.
 */
export const promptStart = (
  base: {
    readonly agent: AgentName
    readonly sessionId: string
    readonly instance: string | null
    readonly startedAt: number
    /** The turn's id, where the harness names one. */
    readonly turn?: string
  },
  prompt: string,
  harness = false,
): HarnessEvent => {
  const nonce = doorbellNonce(prompt)
  if (nonce) return { type: "turn-started", ...base, cause: "doorbell", nonce }
  if (harness || continuationPrompt(prompt))
    return { type: "turn-started", ...base, cause: "harness" }
  const own = withoutDoorbell(prompt)
  return { type: "turn-started", ...base, cause: "prompt", ...(own && { prompt: own }) }
}

/** Quotes a doorbell line for any shell Novadeck starts: it holds no character they expand. */
export const quotedLine = (line: string): string => `"${line}"`

/** A payload's string field, or undefined. */
export const text = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

// Terminal escape sequences: CSI (ESC [ … final), OSC (ESC ] … BEL or ST), and other
// two-character escapes; then any control character left, and the bidirectional
// overrides and isolates that could reorder what a notification shows.
// eslint-disable-next-line no-control-regex -- These are the characters it removes.
const escapes = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g
// eslint-disable-next-line no-control-regex -- As above.
const controls = /[\x00-\x1f\x7f-\x9f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g
// Markdown's marks that read as noise in plain text: emphasis, code, a heading's or a
// quote's lead, a list's bullet, and a link's brackets around its text.
const marks = /(\*\*|`+|~~)/g
const lead = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?)/
const links = /!?\[([^\]]*)\]\([^)]*\)/g

/**
 * The start of an agent's reply as one line of plain text, at most
 * `replyPreviewLength` long: escapes and control characters out, Markdown's marks
 * dropped, lines joined, whitespace collapsed, and an ellipsis where it was cut, never
 * inside a character. Undefined when nothing is left.
 */
export const replyPreview = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined
  const line = value
    // Only as much as can show: a reply may be long, and the hook already cut it.
    .slice(0, replyPreviewLength * 8)
    .replace(escapes, "")
    .split(/\r\n|\r|\n/)
    .map((part) => part.replace(lead, "").replace(links, "$1").replace(marks, ""))
    .join(" ")
    .replace(controls, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!line) return undefined
  if (line.length <= replyPreviewLength) return line
  let end = replyPreviewLength - 1
  const last = line.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return `${line.slice(0, end).trimEnd()}…`
}

/** A turn's end's `reply`, from a field holding the agent's last reply; nothing without one. */
export const replied = (value: unknown): { readonly reply?: string } => {
  const reply = replyPreview(value)
  return reply === undefined ? {} : { reply }
}

/**
 * The facts of a hook, and whether the agent plans: the root agent's turn, tool and stop
 * hooks name its permission mode, `plan` while it plans. None fires when the mode
 * changes, and Claude Code's SessionStart names none, so a session started or cleared in
 * plan mode shows it from its first prompt.
 */
export const withMode = (
  facts: readonly HarnessEvent[],
  payload: Report["payload"],
): readonly HarnessEvent[] => {
  const mode = text(payload.permission_mode)
  const [first] = facts
  if (!mode || !first || text(payload.agent_id)) return facts
  const { agent, instance, startedAt } = first
  return [
    ...facts,
    {
      type: "mode-observed",
      agent,
      sessionId: first.sessionId,
      instance,
      startedAt,
      planning: mode === "plan",
    },
  ]
}

// What a request shows of its subject and choices, bounded as the protocol takes them.
const maxSubject = 1024
const maxChoice = 256
const maxChoices = 16

const field = (input: Record<string, unknown>, ...names: string[]): string | undefined => {
  for (const name of names) {
    const value = input[name]
    if (typeof value === "string" && value.trim()) return value
    if (Array.isArray(value) && value.length > 0 && value.every((each) => typeof each === "string"))
      return value.join(" ")
  }
  return undefined
}

/**
 * What a tool call asks the person about, from its input, in the harness's own words: a
 * question and its choices, a plan's file, a command, or the path or address it touches.
 */
export const subjectOf = (
  input: unknown,
): { readonly subject: string | null; readonly choices: readonly string[] } => {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return { subject: null, choices: [] }
  const fields = input as Record<string, unknown>
  const [question] = Array.isArray(fields.questions) ? fields.questions : []
  if (typeof question === "object" && question !== null) {
    const { question: prompt, options } = question as { question?: unknown; options?: unknown }
    const choices = (Array.isArray(options) ? options : [])
      .map((option) => (option as { label?: unknown } | null)?.label)
      .filter((label): label is string => typeof label === "string" && label.length > 0)
      .slice(0, maxChoices)
      .map((label) => label.slice(0, maxChoice))
    return { subject: typeof prompt === "string" ? prompt.slice(0, maxSubject) : null, choices }
  }
  const subject = field(fields, "planFilePath", "command", "file_path", "path", "url", "pattern")
  return { subject: subject?.slice(0, maxSubject) ?? null, choices: [] }
}

/**
 * An opaque reference to a native identity: clients tell actors and requests apart by
 * it, never by a harness's own ids.
 */
export const ref = (...parts: readonly string[]): string =>
  createHash("sha256").update(parts.join("\0")).digest("base64url").slice(0, 16)

/** The longest plan text kept, as the protocol takes it. */
export const maxPlan = 256 * 1024

/** A plan's text cut short to what the protocol takes, a character left whole. */
export const bounded = (value: string): { readonly text: string; readonly truncated: boolean } => {
  let end = Math.min(value.length, maxPlan)
  const last = value.charCodeAt(end - 1)
  if (end < value.length && last >= 0xd800 && last <= 0xdbff) end -= 1
  return { text: value.slice(0, end), truncated: end < value.length }
}
