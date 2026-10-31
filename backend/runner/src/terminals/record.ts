import type { IMarker } from "@novadeck/emulator/headless"
import type { AgentName } from "@novadeck/protocol"
import type { Terminal } from "@novadeck/terminal/host"
import type { Foreground } from "@novadeck/terminal/pty"
import type { Line } from "@novadeck/terminal/shell"

import type { Activity } from "../harnesses/activity.js"
import type { Binding } from "../harnesses/bindings.js"
import type { Root } from "../harnesses/roots.js"
import type { Telemetry } from "../harnesses/telemetry.js"
import type { Nudges } from "./nudges.js"
import type { AgentReport, AgentTurn } from "./saved-terminals.js"
import type { AgentSummary } from "./summary.js"
import type { Naming } from "./titles.js"
import type { Interruption } from "./transcripts.js"
import type { Work } from "./work.js"

/** A harness session bound to a terminal (`Record.bound`). */
export type Bound = {
  /** The session; `summary.agent` shows it. */
  readonly binding: Binding
  /** What the agent is doing, as its hooks said. */
  readonly activity: Activity
  /** Its tokens and quotas, as its records said; null until they did. */
  readonly telemetry: Telemetry | null
}

/**
 * What the runner holds of a terminal while it runs, or exited and retained: one mutable
 * object per terminal, which every part of the agent layer reads and writes through the
 * slice of it its host names (see architecture/manager-split.md). Saved terminals are
 * `saved-terminals.ts`'s.
 */
export type Record = {
  /** The agent layer's half of its summary; `summaryOf` composes the whole with the host's. */
  summary: AgentSummary
  /** Its run, its screen, its events and who reads them. */
  terminal: Terminal
  /** Closed by the person or an agent, and forgotten: nothing saves it again. */
  closed: boolean
  /** The current shell's last foreground sample; undefined until the first. */
  foreground: Foreground | undefined
  /** Where the terminal was created, for a restart once its last directory is gone. */
  origin: string
  /** The latest session each agent reported in this terminal, across its shells. */
  agents: { [agent in AgentName]?: AgentReport }
  /**
   * The harness session holding the current shell's foreground, with what its hooks and
   * records told of it; null without one. They move as one: a session binds with its fresh
   * activity, and every end takes all of it (`Bindings.endSession`).
   */
  bound: Bound | null
  /**
   * The last binding ended as its process was found gone or its pid reused: a late report of
   * that session from no process or from that one, as from a hook that outlived it, binds
   * it no more. It stays past later bindings, until another such end replaces it: what it
   * drops is only that session's reports from no process or from its dead pid, and an
   * outliving hook of it may still come after the next session of the same agent bound,
   * which it would otherwise replace. A resume of that session in a new process names its
   * own pid, so it binds all the same.
   */
  left?: Binding
  /** Stops following the bound session's own sources, as its transcript. */
  watching: AbortController | null
  /**
   * Stops following each of its subagents with a request waiting, by its id, in its own
   * sources, from when its oldest such request was asked.
   */
  actorWatches: Map<string, { readonly controller: AbortController; readonly since: number }>
  /** The bound session's transcript, where its hooks named one. */
  transcript: string | null
  /** Ends the `agents.transcript` streams reading the bound session's. */
  sourceReaders: Set<AbortController>
  /** When the shell last showed its prompt, in epoch milliseconds. */
  promptedAt: number | null
  /**
   * Markers on the screen's lines where the shell integration reported its latest
   * prompt and the prompt before the latest one a command was entered at, oldest first.
   * A marker follows its line through scrolling, trimming and reflow, and is disposed
   * with it.
   */
  prompts: IMarker[]
  /** The line being typed at the prompt, as far as the keys tell (see `afterKeys`). */
  line: Line
  /** Whether a non-empty line was entered since the last prompt (an empty Enter runs no command). */
  lineEntered: boolean
  /** The title/input generation, so checks made stale by a title or the person's keys are dropped. */
  titles?: number
  /** The latest title the terminal set, which a trust check may read again. */
  title?: string
  /** Reads the latest title again once the person's keys pause, while hooks are untrusted. */
  recheck?: NodeJS.Timeout | undefined
  /** Waits out the harness's say on how the turn the person's Escape ended ended. */
  verdict?: NodeJS.Timeout | undefined
  /**
   * How long the bound session's transcript was when the person's latest Escape came, at
   * `key`, where the transcript records no interruption (`Harness.records` false,
   * Antigravity): once the Escape stands, `interruptions` keeps it.
   */
  escape?: { readonly key: number; readonly offset: Promise<number | undefined> } | undefined
  /**
   * Where the person interrupted turns whose transcript records no interruption, each
   * with its session, for the chat to show among its items (`transcriptChanges`). Only in
   * memory: a runner restart forgets them.
   */
  interruptions?: readonly (Interruption & { readonly sessionId: string })[]
  /** Shows the agent's prompt ready again, once an Enter there started nothing. */
  readyReturn?: NodeJS.Timeout | undefined
  /** Whether its title said a turn runs since the person's Enter at its ready prompt. */
  readyTurned?: boolean
  /** What names it: the person's title, murmur's, and the opening agent's. */
  naming: Naming
  /**
   * The root session of the bound agent, which messages, its prompts and its activity are
   * for, followed as its harness's profile says (see `followRoot`); null without one.
   */
  root: Root | null
  /** What the root session worked on, kept with the terminal; null before any did. */
  work: Work | null
  /** The handle of the terminal whose agent opened this one; null otherwise. */
  openedBy: string | null
  /**
   * The command the agent that opened it started there, whose prompt is never the
   * person's; kept for this runner's lifetime, for its first root session.
   */
  openerCommand: string | null
  /** Whether its first root session after an agent opened it is still to come. */
  awaitsOpened: boolean
  /** The nonce of the doorbell line its agent was started with, as a task, if it was. */
  startedWith?: string
  /**
   * The last typed entry its agent's transcript held at a root turn, by its id, where
   * its hooks name no prompt; undefined before one was read.
   */
  seenEntry: { readonly transcript: string; readonly id: number } | undefined
  /** The shell's own name, as its foreground sample shows it at its prompt; undefined where none is told. */
  shellName: string | undefined
  /** When its agent is next nudged to summarize its work; kept for this runner's lifetime. */
  nudges: Nudges
  /** The agent its shell was opened or restarted to run, until one binds or its startup ends. */
  expecting: AgentName | null
  /** Unsaved changes to what restores it: its directory, program, prompts. */
  changed: boolean
  /** Unsaved output: its transcript, saved on its own schedule. */
  screenChanged: boolean
  /**
   * Whether a line was entered since the last prompt, or the shell resumed an agent, so
   * a program may be running.
   */
  submitted: boolean
  /**
   * Whether the shell was given a command to run at its first prompt (an agent opened or
   * resumed there) that has not been seen to end: the next prompt is then the first after
   * it ran, unless typing cancelled it.
   */
  startupRuns: boolean
  /**
   * The process of a bound agent whose shell prompt came back while it still lived
   * (suspended, as by Ctrl+Z), kept while its lead waits to see whether it returns: a
   * later prompt with no session bound and that process gone ends the lead. Cleared when
   * a session binds again, or the lead ends.
   */
  suspended: string | null
  /**
   * Whether the person pressed Enter at the agent's own prompt shown before any session
   * bound: its first prompt's hooks bind it, so until then nothing says it is idle.
   */
  readyEntered: boolean
  /** The last delivery epoch whose uncertain box got a screen-settling window. */
  boxDoubtEpoch?: number
  /** `performance.now()` at the last save of its screen, so saves take turns. */
  savedAt: number
} & Started

/**
 * A shell's launch, before its terminal belongs to a record: the token
 * its agents report with, whether it runs a startup command, as one that resumes an
 * agent, and the file holding that command, until the shell takes it or it is cancelled.
 */
export type Started = {
  token: string
  resumes: boolean
  resumeFile: string | undefined
  /** The session claimed for the resume, as agent:session, once the shell runs it. */
  resumeClaim?: string | undefined
  /** Whether a binding has ended since the shell started: the claimed session is then past. */
  resumeEnded?: true | undefined
  /** Whether the resumed agent was already judged for a turn the stop cut short (`interruptedFor`). */
  resumeTold?: true | undefined
  /** What the resumed agent was doing when the runner stopped, until judged (`restored`). */
  resumeTurn?: AgentTurn | undefined
}
