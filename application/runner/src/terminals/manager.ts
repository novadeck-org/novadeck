import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants, rmSync, writeFileSync } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve as resolvePath } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import {
  createScreen,
  mouseReporting,
  readScreen,
  replay,
  trackMouse,
  transcript as transcriptOf,
  type IMarker,
  type MouseEncoding,
  type Screen,
  type ScreenText,
} from "@novadeck/emulator/headless"
import type { RequestFacts } from "@novadeck/harness-core/dialogs"
import type {
  ActivityEvent,
  HarnessEvent,
  PromptShown,
  SessionObserved,
} from "@novadeck/harness-core/events"
import {
  doorbellLine,
  firedFacts,
  hookShellSlackMs,
  quotedLine,
  silentFor,
  type Install,
} from "@novadeck/harness-core/harness"
import { type Report } from "@novadeck/harness-core/report"
import type { AskAnswer, InboxLetter } from "@novadeck/protocol"
import type {
  AgentDetail,
  AgentName,
  ForegroundProcess,
  InterruptResult,
  TerminalAttached,
  TerminalChange,
  TerminalEvent,
  TerminalMessages,
  TerminalRequest,
  RequestAnswer,
  TerminalRequestAnswer,
  TerminalSummary,
  TranscriptChange,
} from "@novadeck/protocol"
import { murmurGist, murmurHeadline } from "@novadeck/protocol"
import { relayPath } from "@novadeck/relay"
import {
  createTerminal,
  type Attachment,
  type Emitted,
  type Terminal,
  type TerminalOptions as HostOptions,
} from "@novadeck/terminal/host"
import {
  foregroundProcess,
  foregroundRuns,
  openFiles,
  processGroup,
  processSetting,
  relayMs,
  sampleForeground,
  shellInForeground,
  spawnPty,
  terminalForeground,
  Trees,
  type Disposable,
  type EndBudget,
  type Foreground,
  type NativeSpawn,
  type ProcessTrees,
  type Pty,
} from "@novadeck/terminal/pty"
import {
  afterKeys,
  emptyLine,
  osc7Directory,
  osc9Directory,
  pathKey,
  refreshPath,
  startsCommands,
  withLocale,
  type Line,
  type ShellLaunch,
} from "@novadeck/terminal/shell"
import { freshNonce, InputQueue, keysOf } from "@novadeck/tui-input"
import type { HoldBudget, InputHold, PromptHost, PromptOptions } from "@novadeck/tui-input"
import type { InterruptHost, InterruptOptions } from "@novadeck/tui-input"
import { isEmpty, type BoxProfile } from "@novadeck/tui-input/box"
import { Latest } from "@novadeck/wire/server"

import { readPlanFile, type PlanText } from "../companions/content.js"
import type { CompanionItems, TerminalPlace } from "../companions/items.js"
import type { ItemRecord } from "../companions/records.js"
import {
  readRequest,
  readDismissRequest,
  type PresentAnswer,
  type DismissAnswer,
} from "../companions/request.js"
import { DomainError } from "../errors.js"
import {
  apply,
  escapeScreenMs,
  escapeVerdictMs,
  boundSince,
  started as fresh,
  summary as activitySummary,
  withGist,
  withLimit,
  withHeadline,
  withoutNotes,
  type Activity,
} from "../harnesses/activity.js"
import { observe, type Binding } from "../harnesses/bindings.js"
import { actorOf, agentDetail, requestRef } from "../harnesses/detail.js"
import { resumeAvailability } from "../harnesses/eligibility.js"
import { agents, harnesses } from "../harnesses/registry.js"
import { lastReply, unreplied, withReplies } from "../harnesses/replies.js"
import { followRoot, rootedIn, type Root, type RootChange } from "../harnesses/roots.js"
import {
  limitOf,
  observeTelemetry,
  telemetrySummary,
  type Telemetry,
} from "../harnesses/telemetry.js"
import { transcriptWaitMs, typedPromptStart } from "../harnesses/typed-prompts.js"
import { Asks, type AskRecords } from "../messaging/asks.js"
import { agentLabel } from "../messaging/mailbox.js"
import {
  leaseMargin,
  Messaging,
  type AgentsAnswer,
  type SendAnswer,
} from "../messaging/messaging.js"
import type { MailboxRecords } from "../messaging/records.js"
import type { Describer } from "../murmur/describer.js"
import { inherited } from "../shell/inherited.js"
import type { InstalledShell } from "../shell/install.js"
import { shellLaunch } from "../shell/integration.js"
import {
  listenForReports,
  unanswered,
  unansweredCalls,
  type Ack,
  type Call,
  type HookAnswer,
  type Reports,
} from "../shell/reports.js"
import type { HintFacts } from "../voice/hint.js"
import { Answers, type AnswerHost, type AnswerOptions } from "./answers.js"
import { busy } from "./busy.js"
import {
  allowClose,
  closeLimit,
  readCloseRequest,
  runnerCloseLimit,
  selfRefusal,
  spentRefusal,
  type CloseAnswer,
} from "./closes.js"
import { coalesced } from "./coalesce.js"
import { expectedAgent, promptIn } from "./commands.js"
import { Dialogs, type DialogsHost, type DialogsOptions } from "./dialogs.js"
import { Doorbell, tracer, type DoorbellHost, type DoorbellOptions } from "./doorbell.js"
import { mention, nextHandle, wordOf } from "./handles.js"
import { splitReports } from "./keys.js"
import { leftoverNonce } from "./leftover.js"
import {
  Murmur,
  type MurmurHost,
  type MurmurSubject,
  type MurmurTimes,
  type Reported,
} from "./murmur.js"
import {
  cleanSummary,
  murmured,
  openedWith,
  renamed as renamedTo,
  summarized,
  summaryRefusal,
  titleOf,
  unnamed,
  type Naming,
} from "./naming.js"
import { afterSummary, atPrompt, fired, noNudges, noticesAt, type Nudges } from "./nudges.js"
import {
  allowOpen,
  openLimit,
  prune,
  runnerOpenLimit,
  OpenRequests,
  readOpenRequest,
  refused,
  type Asked,
  type OpenAnswer,
} from "./opens.js"
import { TerminalPeers } from "./peers.js"
import { Interrupts, Prompts } from "./prompting.js"
import {
  hasRun,
  type AgentReport,
  type ListedTerminal,
  type SavedTerminal,
  type TerminalIdentity,
  type TerminalRecords,
} from "./records.js"
import { restoredSeparator } from "./restored.js"
import { readSummarizeRequest, type SummarizeAnswer } from "./summarize.js"
import { transcriptChanges } from "./transcripts.js"
import { TerminalWatcher } from "./watcher.js"
import { judgedFirst, workAfter, type Work } from "./work.js"

const OUTPUT_CHARS = 4096
// How much read output may wait to be drawn before the program is paused, in characters.
// Pausing for every chunk until it is drawn waits on a timer each time, about 15 ms on
// Windows: a TUI that redraws for every key of a paste, as Codex does there, where the
// paste reaches it as keys, then showed 100 characters in 6 s rather than 0.3 s.
const OUTPUT_WAITING_CHARS = 256 * 1024

/** How long after the person's last key an untrusted agent's hooks are asked about again. */
export const trustRecheckMs = 1000

/**
 * How long after the person's Enter at an agent's own prompt, before its first, a session
 * must bind or a turn show, or that Enter submitted no prompt (a command such as Codex's
 * `/status`, or nothing): a prompt binds in about a second (probed 2026-10-04, 0.159.3).
 */
export const readyReturnMs = 5000

export type TerminalOptions = {
  shell?: string
  shellArgs?: readonly string[]
  /** Variables shells get on top of `baseEnv`. */
  env?: NodeJS.ProcessEnv
  /** The environment shells start from: the runner's own when omitted. */
  baseEnv?: NodeJS.ProcessEnv
  /**
   * Whether each new shell's PATH is read anew, as Windows keeps it, so a program
   * installed since the app started is on it (see `refreshPath`). On unless `baseEnv`
   * sets the environment exactly.
   */
  freshPath?: boolean
  /** Running and retained terminals together; unlimited when omitted. */
  maxTerminals?: number
  /** Exited, unattached records kept for viewing or restart; the oldest go first. */
  maxRetained?: number
  historyBytes?: number
  subscriberBytes?: number
  snapshotBytes?: number
  ackWindowBytes?: number
  /** How often running terminals' foreground processes are sampled, in milliseconds. */
  processPollMs?: number
  /**
   * The shell integration and hook, once written (see `installShellFiles`). Without
   * them, shells start as they are and no agent session is reported.
   */
  shellFiles?: Promise<InstalledShell | undefined>
  /** Where terminals are saved for restoring; unsaved when omitted. */
  records?: TerminalRecords
  /** The connected harnesses whose shims new shells put first on PATH. */
  shims?: () => Promise<readonly AgentName[]>
  /**
   * Whether Novadeck's plugin is installed into the harness: a disconnected one resumes
   * nothing and its reports are ignored. Every harness counts as connected when omitted.
   */
  connected?: (agent: AgentName) => Promise<boolean>
  /** Whether terminals' transcripts are kept, until `keepTranscripts` changes it. */
  transcripts?: boolean
  /** How often changed terminals are saved, in milliseconds. */
  saveMs?: number
  /** The longest transcript kept per terminal, in characters. */
  transcriptChars?: number
  /**
   * What agents show beside terminals, and the plans each terminal's agent keeps there;
   * agents show nothing without it.
   */
  items?: CompanionItems
  /** The folder of the project a session belongs to, which names the files its agents show. */
  projectFolder?: (sessionId: string) => string | undefined
  /** How long an agent's request for a new terminal waits for the client's answer, in milliseconds. */
  openMs?: number
  /** Where agents' messages, their threads and the messaging pause are kept; in memory when omitted. */
  mailbox?: MailboxRecords
  asks?: AskRecords
  /**
   * The project a session belongs to, whose terminals' agents message each other; each
   * session counts as its own when omitted, or when that cannot be told.
   */
  projectOf?: (sessionId: string) => string | undefined
  /**
   * Writes terminals' titles and summaries (see `Murmur`); nothing is described without it.
   * `murmurTimes` shortens its waits, as in some tests.
   */
  describer?: Describer
  murmurTimes?: Partial<MurmurTimes>
  /** How the doorbell rings idle agents; it never rings with `false`, as in some tests. */
  doorbell?: DoorbellOptions | false
  /** How prompts the chat gives agents are typed, with its waits, as in some tests. */
  prompts?: PromptOptions
  /** How interrupts wait, as in some tests. */
  interrupts?: InterruptOptions
  /** How answers the chat gives agents' dialogs are pressed, and how dialogs are read, with their waits, as in some tests. */
  answers?: AnswerOptions & DialogsOptions
  /**
   * Where a harness lives on this machine, which says how it may start with a task; a
   * harness counts as having none when omitted.
   */
  install?: (agent: AgentName) => Promise<Install | undefined>
  /**
   * Whether Novadeck's hooks run for the harness in a folder, where it runs them only
   * once the person trusts them (`Harness.hooksTrusted`); asked of the harness itself when
   * omitted. Undefined, or a failure, is unknown.
   */
  hooksTrusted?: (agent: AgentName, cwd: string) => Promise<boolean | undefined>
  /**
   * The platform harnesses run their hooks on, which sets how long a hook may take to come
   * (see `hookShellSlackMs`); the runner's own when omitted.
   */
  platform?: NodeJS.Platform
  /**
   * The runner's own relay, which on Windows reads the registry's PATH and terminals'
   * process trees; the one `@novadeck/relay` built when omitted. Never the copy installed
   * for agents, which may be another build's, and waits on the shell files being written.
   */
  relay?: string
  /**
   * The pty as a test plays it: node-pty's `spawn`, the platform its ending follows (this
   * system's when omitted, whatever `platform` says, as real shells run here), and the
   * process trees a Windows terminal's programs are ended by.
   */
  pty?: {
    readonly native?: NativeSpawn
    readonly platform?: NodeJS.Platform
    readonly trees?: ProcessTrees
  }
}

type Create = {
  id: string
  sessionId: string
  cwd: string
  cols: number
  rows: number
  restore?: boolean | undefined
  resume?: AgentName | undefined
  /** Runs once at the shell's first prompt; never with `restore` or `resume`. */
  command?: string | undefined
  /** Its title; a restored one keeps its saved title, and a new one takes its session's next default. */
  title?: string | undefined
  /** The agent's request it answers, whose opener it is opened for, with the title asked for. */
  requestId?: string | undefined
}
type Size = { cols: number; rows: number }
type Attach = { terminalId: string; afterSequence?: number; mode?: "control" | "observe" }
type Record = {
  summary: TerminalSummary
  process: Pty
  screen: Screen
  /** Its events and who reads them. */
  terminal: Terminal
  chain: Promise<void>
  pendingReads: number
  /** The output read but not yet on its screen, in characters; see `output`. */
  pendingOutput: number
  /**
   * Output read for the draw queued last, and the program each came from, while that draw
   * is still the chain's last work and hasn't begun: later output joins it. Null once it
   * began, or once other work was queued after it, as a resize, which later output must
   * not be drawn ahead of.
   */
  unread: { readonly child: Pty; readonly data: string }[] | null
  pendingAttachments: number
  exitQueued: boolean
  /** Closed by the person or an agent, and forgotten: nothing saves it again. */
  closed: boolean
  exited: Promise<void>
  resolveExit: () => void
  listeners: Disposable[]
  closing: Promise<void> | undefined
  /** `performance.now()` at spawn, for the exit's `ranMs`. */
  startedAt: number
  restarting: boolean
  /** When the shell last exited, in exit order across terminals; eviction goes oldest first. */
  exitOrder: number
  /** The current shell's last foreground sample; undefined until the first. */
  foreground: Foreground | undefined
  /** Where the terminal was created, for a restart once its last directory is gone. */
  origin: string
  /** The latest session each agent reported in this terminal, across its shells. */
  agents: { [agent in AgentName]?: AgentReport }
  /** The harness session holding the current shell's foreground; `summary.agent` shows it. */
  binding: Binding | null
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
  /** What the bound agent is doing, as its hooks said; null without a binding. */
  activity: Activity | null
  /** The bound agent's tokens and quotas, as its records said; null until they did. */
  telemetry: Telemetry | null
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
  /**
   * The root session murmur was last told of, as `agent:session`; null before any. A
   * session is new to murmur only when `work` moves off it, so a restored terminal that
   * binds its saved session again is not.
   */
  murmurSession: string | null
  /**
   * What waits while the input queue's work is at the agent's box (see `InputQueue`): the
   * person's input, while a ring's test paste, a prompt's paste or an answer's keys are on
   * screen (null once that's let go, after its Enter), and the latest size the app asked
   * for, until the work has settled (a ring's prompt confirms it or it fails), as a
   * resize redraws the screen the paste is checked on, and one landing as the doorbell's
   * turn starts crashed Codex (0.159.3); null otherwise.
   */
  held: {
    input: string[] | null
    /** Whether the keys held count as the person's only once delivered (an answer's hold may drop them). */
    deferred?: boolean
    /**
     * When the resizes may be applied at the earliest, in epoch milliseconds: a settle
     * before it waits (see `InputHold.settleAfter`), and the next hold takes it over.
     */
    notBefore?: number
    size: {
      readonly cols: number
      readonly rows: number
      readonly owner: string
      /** The owner's attachment that asked, as a window showing it anew attaches again. */
      readonly attachment: Attachment | undefined
    } | null
  } | null
  /** When its window was last resized, in epoch milliseconds; 0 before any resize. */
  resizedAt: number
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
  /** Unsaved changes: output, directory, or prompts. */
  changed: boolean
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
} & Omit<Started, "process" | "screen" | "startedAt">

/**
 * A spawned shell with its own headless screen, before it belongs to a record: the token
 * its agents report with, whether it runs a startup command, as one that resumes an
 * agent, and the file holding that command, until the shell takes it or it is cancelled.
 */
type Started = {
  process: Pty
  screen: Screen
  /** The mouse's encoding a program set on its screen. */
  mouseEncoding: () => MouseEncoding
  startedAt: number
  token: string
  resumes: boolean
  resumeFile: string | undefined
  /** The session claimed for the resume, as agent:session, once the shell runs it. */
  resumeClaim?: string | undefined
}

/** The runner's shell integration, once its files are written and reports are heard. */
type Integration = { readonly paths: InstalledShell; readonly reports: Reports }

// Whether process `pid` still runs; one the platform refuses to signal belongs to someone
// else, and runs.
const alive = (pid: string): boolean => {
  try {
    process.kill(Number(pid), 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

// Why a request for a new terminal went unanswered.
const unopened = {
  nobody: "Novadeck isn't open to show a new terminal.",
  // Its window may still open it, so the agent should look before asking again.
  gone: "Novadeck's window went away while opening the terminal; it may still open, so check before asking again.",
  late: "Novadeck didn't confirm the new terminal in time; it may still open, so check before asking again.",
}

/** What murmur reads of a running terminal's record. */
const murmurSubject = (record: Record): MurmurSubject => ({
  summary: record.summary,
  naming: record.naming,
  work: record.work,
  activity: record.activity,
  openedBy: record.openedBy,
  agent: record.binding?.agent ?? null,
  transcript: record.transcript,
  program: record.summary.process,
  atPrompt: shellAtPrompt(record),
  expecting: record.binding === null ? record.expecting : null,
})

/**
 * The screen row the shell's last command was typed on, from the prompt markers: at the
 * prompt, the line of the prompt before the current one; while a program runs, or a line
 * was entered and its prompt has not been reported yet, the line of the latest, which the
 * command was started from. A marker marks the first line of its prompt, which is the
 * command's line for a one-line prompt. Undefined with no such marker, when its line has
 * left the screen or the buffer, when a full-screen program draws, or when the line is now
 * blank (cleared in place): never another line's row. A prompt no command was entered at
 * keeps no marker, so the row is the last command's, not an empty Enter's. On Windows,
 * ConPTY may desync OSC 9;9 from the frames it renders and repaint on resize, so the row
 * there is best-effort.
 */
const commandRowOf = (record: Record): number | undefined => {
  const buffer = record.screen.buffer.active
  if (buffer.type === "alternate") return undefined
  const running = !shellAtPrompt(record) || record.lineEntered
  const marker = running ? record.prompts.at(-1) : record.prompts.at(-2)
  if (!marker || marker.isDisposed || marker.line < 0) return undefined
  const row = marker.line - buffer.viewportY
  if (row < 0 || row >= record.screen.rows) return undefined
  const line = buffer.getLine(marker.line)
  return line && line.translateToString(true).trim() !== "" ? row : undefined
}

// Whether the shell holds its terminal's foreground, as at its prompt: by the foreground
// process group where the platform tells it, so a script its own interpreter runs (`bash
// deploy.sh`) is a program; else by the foreground program's name, and, with none told (as
// on Windows), it does.
const shellAtPrompt = (record: Record): boolean => {
  const group = record.foreground?.group
  if (group !== undefined && group !== null) return group === record.process.pid
  const name = record.summary.process?.name
  return name === undefined || record.shellName === undefined || name === record.shellName
}

// How much time a prompt's hook must have left for drift to be read, in milliseconds:
// a git branch and a plan's file, each with its own short timeout.
const driftReadMs = 1_500

const sameToken = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// How many changed terminals one periodic save handles.
const savesPerTick = 4

/** The shell until the first sample, which may add its command line; Windows reports none. */
const shellProcess = (shell: string): ForegroundProcess | null => {
  const name = basename(shell).slice(0, 256)
  return process.platform === "win32" || !name ? null : { name, argv: null }
}

const sameProcess = (a: ForegroundProcess | null, b: ForegroundProcess | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.name === b.name &&
    a.argv?.length === b.argv?.length &&
    (a.argv ?? []).every((arg, index) => arg === b.argv?.[index]))

// How long a closed Windows terminal's programs have to end by themselves once its
// console closes, as they do on its CTRL_CLOSE_EVENT, saving what they were writing, in
// milliseconds: within the five seconds Windows gives them. What is left of the terminal's
// tree then, as a hook's shell in a console of its own, is ended. Shorter as the runner
// shuts down, which the app gives five seconds in all (host/src/main/runner.ts).
const treeGraceMs = 3_000
const shutdownTreeGraceMs = 1_000

// How long ending terminals' trees may take in all as the runner shuts down, in
// milliseconds: every relay run, taskkill and grace then takes its time from this, within
// the five seconds the app gives the runner, with room for a shell's exit (its own 1 s wait)
// and for closing the rest of the runner after.
const shutdownTreesMs = 3_000

const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Terminal limits must be positive integers.")
  return result
}

/**
 * A terminal's events and attachments, its budgets counting each event as the wire sends
 * it, in its envelope; its snapshots are of `record`'s screen.
 */
const hosted = (
  limits: HostOptions["limits"],
  terminalId: string,
  record: () => Record,
  controller: string | undefined,
): Terminal =>
  createTerminal({
    eventBytes: (event) => Buffer.byteLength(JSON.stringify({ ...event, terminalId })),
    limits,
    controller,
    view: () => {
      const { screen, summary, mouseEncoding } = record()
      return {
        screen,
        cols: summary.cols,
        rows: summary.rows,
        exit: summary.exit,
        mouse: mouseEncoding(),
      }
    },
  })

/** How long `settleBox` looks at a screen for an empty box, in milliseconds. */
const boxSettleMs = 5_000

/**
 * Owns PTYs for one runner lifetime. Exited, unattached records are retained up to a
 * bound, and evicted oldest first beyond it or when a capped runner needs room.
 */
export class Terminals {
  private readonly records = new Map<string, Record>()
  /** The terminals whose box `settleBox` is looking at. */
  private readonly settling = new Set<string>()
  /** Closed records already gone from `records` whose viewers still read their last events. */
  private readonly draining = new Map<string, Record>()
  private readonly pendingOwners = new Map<string, Set<{ released: boolean }>>()
  /** Each `watch` stream and the owner whose release ends it. */
  private readonly watchers = new Map<TerminalWatcher, string>()
  /** Each terminal's `agents.detail` readers. */
  private readonly details = new Map<string, Set<Latest<AgentDetail>>>()
  /** Each terminal's `messages.watch` readers. */
  private readonly mail = new Map<string, Set<Latest<TerminalMessages>>>()
  /** Agents' requests for a new terminal, on their way to the client. */
  private readonly opens = new OpenRequests()
  /**
   * When each chain's agents opened terminals lately, for `openLimit`. A chain's times
   * outlive the terminal that began it, until they pass out of the window, so the
   * terminals it opened can't start afresh by closing it; `prune` lets them go then.
   */
  private readonly opened = new Map<string, readonly number[]>()
  // Which terminal a terminal opened on request is charged to: the one that began the
  // chain, so terminals opening terminals share one budget rather than each get theirs.
  private readonly openers = new Map<string, string>()
  // Every request's time, for the runner's own limit across all chains.
  private allOpened: readonly number[] = []
  /**
   * When each chain's agents closed terminals lately, for `closeLimit`: charged as opens
   * are, to the terminal that began the chain, from a budget apart from theirs, and kept
   * as theirs are.
   */
  private readonly closed = new Map<string, readonly number[]>()
  // Every close's time, for the runner's own limit across all chains.
  private allClosed: readonly number[] = []
  private sampler: ReturnType<typeof setInterval> | undefined
  private saver: ReturnType<typeof setInterval> | undefined
  private readonly options: Required<
    Omit<
      TerminalOptions,
      | "env"
      | "baseEnv"
      | "shellArgs"
      | "shellFiles"
      | "records"
      | "shims"
      | "connected"
      | "transcripts"
      | "projectFolder"
      | "mailbox"
      | "asks"
      | "projectOf"
      | "doorbell"
      | "prompts"
      | "interrupts"
      | "answers"
      | "install"
      | "hooksTrusted"
      | "items"
      | "describer"
      | "murmurTimes"
      | "pty"
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
    hooksTrusted: ((agent: AgentName, cwd: string) => Promise<boolean | undefined>) | undefined
    items: CompanionItems | undefined
  }
  private readonly integration: Promise<Integration | undefined>
  /** Windows' process trees, which a closed terminal's programs are ended by. */
  private readonly trees: ProcessTrees
  /** How terminals' ptys start, and the platform their ending follows. */
  private readonly pty: { readonly native?: NativeSpawn; readonly platform: NodeJS.Platform }
  private transcripts: boolean
  /** The handles each session has given, without records to keep them. */
  private readonly handles = new Map<string, ReadonlySet<string>>()
  /** Each terminal's agent reports and asks waiting their turn, in the order they came. */
  private readonly reports = new Map<string, Promise<void>>()
  /** Agents' messages to each other, and how each terminal's agent takes them. */
  private readonly messaging: Messaging
  private readonly asks: Asks
  /** What agents messaging each other, and the runner API about their messages, are answered. */
  private readonly peers: TerminalPeers
  /** Wakes idle agents for their messages; none when switched off. */
  private readonly doorbell: Doorbell | undefined
  /** Describes terminals with murmur; undefined without a describer. */
  private readonly murmur: Murmur | undefined
  private readonly prompts: Prompts
  /** Each terminal's input queue: every piece of work that puts keys in its agent's box. */
  private readonly inputs: InputQueue
  private readonly interrupts: Interrupts
  /** Answers requests through their dialogs, and the dialogs it reads for `agents.detail`. */
  private readonly answers: Answers
  private readonly dialogs: Dialogs
  /** Sessions given out to resume, as agent:session, and the terminal each went to. */
  private readonly claims = new Map<string, string>()
  /** Terminals closed in this runner's lifetime, which no create brings back. */
  private readonly closedIds = new Set<string>()
  /** Sessions whose project is going or gone, in which no terminal starts again. */
  private readonly closingSessions = new Set<string>()
  /** How many times each harness was disconnected, so a report that waited meanwhile is dropped. */
  private readonly disconnections = new Map<AgentName, number>()
  private creating = 0
  private exits = 0
  private stopping = false
  /** The runner has stopped: its records may be closed, and nothing reads or forgets them. */
  private stopped = false
  /** When the runner's shutdown must have ended terminals' trees by, once it has begun. */
  private shutdownBy: number | undefined
  private shutdownPromise: Promise<void> | undefined

  constructor(options: TerminalOptions = {}) {
    this.options = {
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
      hooksTrusted: options.hooksTrusted,
      items: options.items,
      platform: options.platform ?? process.platform,
      relay: options.relay ?? relayPath,
    }
    // Child programs do not need the runner's network capability, nor the identity of a
    // Novadeck terminal the runner itself was started from.
    for (const name of inherited) delete this.options.env[name]
    this.trees = options.pty?.trees ?? new Trees(async () => this.options.relay)
    this.pty = {
      ...(options.pty?.native && { native: options.pty.native }),
      platform: options.pty?.platform ?? process.platform,
    }
    // Read once now, so the first terminal doesn't wait for it; see `shellEnvironment`.
    // After the deletes, as the relay, or PowerShell, that reads it gets this environment.
    if (this.options.freshPath) void this.shellEnvironment()
    this.transcripts = options.transcripts ?? true
    this.messaging = new Messaging({
      ...(options.mailbox && { records: options.mailbox }),
      platform: this.options.platform,
      // A message is kept while either of its terminals is, running or saved.
      exists: (terminalId) =>
        this.records.has(terminalId) || this.identity(terminalId) !== undefined,
    })
    this.asks = new Asks(
      {
        owner: (id) => this.messaging.inboxOwner(id),
        reply: (id, ask, subject, text, commit, choice) =>
          this.messaging.personReply(id, ask, subject, text, commit, choice),
        replyState: (id) => this.messaging.inboxReply(id),
        forgetReplies: (ids) => this.messaging.forgetResponses(ids),
        changed: (id) => this.mailChanged(id),
        exists: (id) =>
          !this.closedIds.has(id) && (this.records.has(id) || this.identity(id) !== undefined),
      },
      options.asks,
    )
    this.inputs = new InputQueue({
      hold: (terminalId, budget) => this.holdInput(terminalId, budget),
    })
    this.doorbell =
      options.doorbell === false
        ? undefined
        : new Doorbell(this.ringHost(), this.inputs, {
            platform: this.options.platform,
            ...options.doorbell,
          })
    // A lapsed continuation ends its turn; a late prompt may leave only box doubt to settle.
    this.messaging.subscribe((change) => {
      if (change.kind !== "terminal") return
      const record = this.records.get(change.terminalId)
      if (record) {
        this.lapsed(record)
        this.settleBox(record)
      }
    })
    this.prompts = new Prompts(this.promptHost(), this.inputs, options.prompts)
    this.interrupts = new Interrupts(this.interruptHost(), {
      // The queued turn shows working only once its hook comes, which its shell holds back.
      queuedTurnMs: 3_000 + hookShellSlackMs(this.options.platform) / 4,
      ...options.interrupts,
    })
    this.dialogs = new Dialogs(this.dialogsHost(), options.answers)
    this.answers = new Answers(this.answerHost(), this.inputs, options.answers)
    const doorbell = this.doorbell
    if (doorbell)
      this.messaging.subscribe((change) => {
        if (change.kind === "terminal") doorbell.changed(change.terminalId)
      })
    // The pause shows in every terminal's listing; anything else only in the terminal's.
    // A burst of changes makes one listing, once this tick.
    const mailChanged = coalesced(
      (terminalId) => this.mailChanged(terminalId),
      "Novadeck could not tell its message watches:",
    )
    this.messaging.subscribe((change) => {
      if (change.kind === "terminal") mailChanged(change.terminalId)
      else for (const terminalId of this.mail.keys()) mailChanged(terminalId)
    })
    this.peers = new TerminalPeers({
      messaging: this.messaging,
      caller: (terminalId, token) => {
        const record = this.records.get(terminalId)
        return record && !record.exitQueued && sameToken(record.token, token) ? record : undefined
      },
      terminal: (terminalId) => this.records.get(terminalId),
      running: (sessionId) =>
        [...this.records.values()].filter(
          (record) => record.summary.sessionId === sessionId && record.summary.exit === null,
        ),
      projectFolder: (sessionId) => this.projectFolder(sessionId),
      stopping: () => this.stopping,
    })
    this.murmur = options.describer
      ? new Murmur(options.describer, this.murmurHost(), options.murmurTimes)
      : undefined
    this.integration = this.integrate(options.shellFiles)
  }

  /** Listens for agent reports once the shell files are written; shells start plainly without. */
  private async integrate(
    shellFiles: TerminalOptions["shellFiles"],
  ): Promise<Integration | undefined> {
    try {
      const paths = await shellFiles
      if (!paths) return undefined
      const reports = await listenForReports({
        report: (report) => this.queueReport(report),
        ask: (report, deadline) => this.queueAsk(report, deadline),
        ack: (ack) => this.acknowledge(ack),
        call: (call) => this.call(call),
      })
      if (!this.stopping) return { paths, reports }
      await reports.close()
    } catch (error) {
      console.error("Novadeck shell integration is unavailable:", error)
    }
    return undefined
  }

  /**
   * Starts a terminal. With `restore`, it continues the saved terminal of that id: in its
   * last directory, with its saved agent sessions, and its transcript shown first unless
   * the shell resumes the session `resume` last reported there (see `claim`). With
   * `command`, the shell runs it at its first prompt; a shell that can't, as without the
   * integration, does not start.
   */
  async create(input: Create, ownerId: string): Promise<TerminalSummary> {
    if (this.stopping) throw new DomainError("CLOSING")
    // A closed terminal stays closed, even while its shell is still ending.
    if (this.closedIds.has(input.id)) throw new DomainError("TERMINAL_NOT_FOUND")
    // Checked before eviction, so a retained exited record keeps its id taken.
    this.available(input.id)
    this.evict(true)
    if (this.records.size + this.creating >= this.options.maxTerminals)
      throw new DomainError("TERMINAL_LIMIT", "Terminal limit reached.")
    this.creating += 1
    const pending = this.pending(ownerId)
    // An agent's request this answers: read now, as it may stop waiting meanwhile.
    const opener =
      input.requestId === undefined
        ? undefined
        : this.opens.opener(input.requestId, ownerId, input.sessionId)
    try {
      // A new terminal's handle is drawn as it is asked for, before anything waits, so
      // terminals asked for together are named, and listed, in the order they were.
      const drawn = input.restore ? undefined : this.nextHandle(input.sessionId)
      const saved = input.restore ? this.saved(input.id, input.sessionId) : undefined
      // Read beside the waits below, which it outlasts on Windows; see `shellEnvironment`.
      const environment = this.shellEnvironment()
      const origin = await this.directory(input.cwd)
      // A saved directory that is gone falls back to the one asked for.
      const cwd = saved ? await this.directory(saved.cwd).catch(() => origin) : origin
      const shell = await this.executable(cwd, environment)
      const integration = await this.shellIntegration()
      const connected = await this.connected(input.resume)
      const env = await environment
      if (this.stopping) throw new DomainError("CLOSING")
      // Closed, even while it was being restored, as from another window, or its project is
      // going: it stays closed, and none starts there.
      if (this.closedIds.has(input.id) || this.closingSessions.has(input.sessionId))
        throw new DomainError("TERMINAL_NOT_FOUND")
      // A concurrent creation may have taken the id meanwhile.
      this.available(input.id)
      // Read again after every wait above: a rename meanwhile, as from another window,
      // stands. Nothing waits between this and saving it, and a terminal that can't be
      // given a handle fails before its shell starts. Only one saved for this session counts:
      // another's handle and opener mean nothing here, and must never give a terminal
      // there a lead.
      const kept = saved ? this.identity(input.id) : undefined
      // Every new terminal draws its session's next handle, even one given its own title.
      const handle = kept?.handle ?? drawn ?? this.nextHandle(input.sessionId)
      // A title it is created with is the person's, as the client's; the one an agent
      // asked for, as it requested the terminal, is that agent's.
      let naming: Naming = kept?.naming ?? unnamed
      if (input.title !== undefined) naming = renamedTo(naming, input.title)
      if (opener?.title !== undefined) naming = openedWith(naming, opener.title, opener.by)
      const openedBy = kept?.openedBy ?? opener?.by ?? null
      const ledBy = kept ? kept.ledBy : opener?.withBrief ? opener.by : null
      const work = saved?.work ?? null
      const command = input.command ?? saved?.command ?? null
      const titled = this.titled(naming, { command })
      const resume =
        input.command === undefined &&
        input.resume &&
        this.resumable(input.id, input.resume, saved?.agents[input.resume]?.sessionId, connected)
      const startup =
        input.command !== undefined
          ? { command: input.command, required: true }
          : resume && { command: resume.argv.join(" ") }
      const started = this.spawn(shell, cwd, input, integration, env, startup || undefined)
      if (resume && started.resumes) {
        this.claims.set(resume.key, input.id)
        started.resumeClaim = resume.key
      }
      const record: Record = {
        summary: {
          id: input.id,
          sessionId: input.sessionId,
          ...titled,
          handle,
          ledBy,
          openedBy,
          agentRan: hasRun(saved?.agents ?? {}),
          started: true,
          command,
          lastProgram: saved?.lastProgram ?? null,
          cwd,
          cols: input.cols,
          rows: input.rows,
          exit: null,
          process: shellProcess(shell),
          run: 1,
          agent: null,
          ready: null,
          activity: null,
          telemetry: null,
        },
        ...started,
        terminal: hosted(
          this.options,
          input.id,
          () => record,
          pending.released ? undefined : ownerId,
        ),
        chain: Promise.resolve(),
        pendingReads: 0,
        pendingOutput: 0,
        unread: null,
        pendingAttachments: 0,
        exitQueued: false,
        closed: false,
        exited: Promise.resolve(),
        resolveExit: () => {},
        listeners: [],
        closing: undefined,
        restarting: false,
        exitOrder: 0,
        foreground: undefined,
        origin,
        agents: saved?.agents ?? {},
        binding: null,
        suspended: null,
        activity: null,
        telemetry: null,
        watching: null,
        actorWatches: new Map(),
        transcript: null,
        sourceReaders: new Set(),
        promptedAt: saved?.promptedAt ?? null,
        prompts: [],
        line: emptyLine,
        lineEntered: started.resumes,
        changed: false,
        savedAt: 0,
        submitted: started.resumes,
        startupRuns: started.resumes,
        readyEntered: false,
        naming,
        root: null,
        work,
        murmurSession: work?.session ?? null,
        held: null,
        resizedAt: 0,
        openedBy,
        openerCommand: opener?.command ?? null,
        // Only a session the opener's command started, running an agent, is the opener's.
        awaitsOpened:
          opener !== undefined && !kept && expectedAgent(opener.command, undefined) !== null,
        seenEntry: undefined,
        shellName: shellProcess(shell)?.name,
        nudges: noNudges,
        expecting: null,
      }
      this.records.set(record.summary.id, record)
      // Restored as a shell that resumes nothing, there is no agent left to lead.
      const unled = record.summary.ledBy !== null && !started.resumes
      if (unled) record.summary = { ...record.summary, ledBy: null }
      this.register(record, expectedAgent(input.command, input.resume))
      if (unled) this.messaging.endLead(record.summary.id)
      // The resumed agent shows its own history; a shell that resumes none, the transcript.
      const shown = saved?.transcript && !started.resumes && this.transcripts
      if (shown) this.show(record, saved.transcript!, new Date(saved.savedAt))
      this.listen(record)
      this.announce(record)
      this.sampleProcesses()
      // A restored transcript stays saved until this shell's own screen replaces it.
      this.save(record, !saved)
      this.saveChanges()
      return { ...record.summary }
    } finally {
      this.creating -= 1
      this.complete(ownerId, pending)
    }
  }

  /**
   * Every terminal of a session, or of all: those running, and those kept only as saved,
   * which have no shell in this runner's lifetime until a client restores them.
   */
  list(sessionId?: string): TerminalSummary[] {
    const live = new Map(
      [...this.records.values()]
        .filter(
          (record) =>
            !record.closed && (sessionId === undefined || record.summary.sessionId === sessionId),
        )
        .map((record) => [record.summary.id, { ...record.summary }] as const),
    )
    let kept: readonly ListedTerminal[] = []
    this.persisting(() => {
      kept = this.options.records?.terminals(sessionId) ?? []
    })
    // In the order they were asked for, as the records keep them; a running one they don't
    // keep, as without records, follows.
    const listed = kept.flatMap((terminal) => {
      const running = live.get(terminal.id)
      if (running) return [running]
      return this.draining.has(terminal.id) ? [] : [this.savedSummary(terminal)]
    })
    const recorded = new Set(kept.map(({ id }) => id))
    // Those the records don't keep, in the order their handles were given.
    const given = (summary: TerminalSummary) =>
      [...(this.handles.get(summary.sessionId) ?? [])].indexOf(summary.handle)
    const unrecorded = [...live.values()]
      .filter(({ id }) => !recorded.has(id))
      .toSorted((a, b) => given(a) - given(b))
    return [...listed, ...unrecorded]
  }

  /** A terminal kept only as saved, as clients see it: no shell, its last facts. */
  private savedSummary(terminal: ListedTerminal): TerminalSummary {
    return {
      id: terminal.id,
      sessionId: terminal.sessionId,
      ...this.titled(terminal.naming, terminal),
      handle: terminal.handle,
      ledBy: terminal.ledBy,
      openedBy: terminal.openedBy,
      agentRan: hasRun(terminal.agents),
      started: false,
      command: terminal.command,
      lastProgram: terminal.lastProgram,
      cwd: terminal.cwd,
      cols: 80,
      rows: 24,
      run: 0,
      exit: null,
      process: null,
      agent: null,
      ready: null,
      activity: null,
      telemetry: null,
    }
  }

  /** A kept terminal's handle, title and who gave it, read alone. */
  private identity(terminalId: string): TerminalIdentity | undefined {
    let kept: TerminalIdentity | undefined
    this.persisting(() => {
      kept = this.options.records?.terminalIdentity(terminalId)
    })
    return kept
  }

  /**
   * The handle a session gives its next terminal, never one it gave before: from its
   * records when the runner keeps them, else counted in memory. When the records can't
   * give one, no terminal is created, since a handle chosen afresh could repeat one.
   */
  private nextHandle(sessionId: string): string {
    const { records } = this.options
    if (!records) {
      const given = this.handles.get(sessionId) ?? new Set<string>()
      const live = [...this.records.values()]
        .filter((record) => !record.closed)
        .map((record) => record.summary)
      const handle = nextHandle(
        {
          given,
          open: live
            .filter((summary) => summary.sessionId === sessionId)
            .map((summary) => summary.handle),
        },
        new Set(
          live
            .filter((summary) => summary.sessionId !== sessionId)
            .map((summary) => wordOf(summary.handle)),
        ),
      )
      this.handles.set(sessionId, new Set(given).add(handle))
      return handle
    }
    let handle: string | undefined
    this.persisting(() => {
      handle = records.giveHandle(sessionId)
    })
    if (this.stopping) throw new DomainError("CLOSING")
    if (handle === undefined)
      throw new Error(
        "Novadeck couldn't give a new terminal a handle in its workspace database, so it didn't create it.",
      )
    return handle
  }

  /**
   * Lets the terminal's agent message, and be messaged by, the others of its project and
   * session, expecting `agent` there, as the one it was opened or restarted to run.
   */
  private register(record: Record, agent: AgentName | null): void {
    const { id, sessionId, handle } = record.summary
    // Its lead is the agent in the terminal that opened it with a brief, until the agent
    // it leads exits.
    this.messaging.register(
      id,
      { projectId: this.projectOf(sessionId), sessionId },
      handle,
      record.summary.ledBy,
    )
    this.messaging.expect(id, agent)
    record.expecting = agent
  }

  /**
   * Renames a terminal, running or saved, and tells every watcher; one the runner keeps
   * nothing of is TERMINAL_NOT_FOUND.
   */
  rename(input: { terminalId: string; title: string }): void {
    if (this.stopping) throw new DomainError("CLOSING")
    this.name(input.terminalId, input.title)
  }

  /**
   * Takes away the title the person gave a terminal, running or saved, so its title is
   * automatic again (see `titleOf`), and tells every watcher; as `rename` otherwise.
   */
  resetTitle(input: { terminalId: string }): void {
    if (this.stopping) throw new DomainError("CLOSING")
    this.name(input.terminalId, null)
  }

  /** Gives a terminal the person's title, or with null takes it away, telling every watcher. */
  private name(terminalId: string, title: string | null): void {
    const record = this.records.get(terminalId)
    if (record) {
      record.naming = renamedTo(record.naming, title)
      // Watchers hear of a rename even to the title it already had.
      if (!this.retitle(record)) this.announce(record)
      this.save(record, false)
      return
    }
    let renamed = false
    this.persisting(() => {
      renamed = this.options.records?.renameTerminal(terminalId, title) ?? false
    })
    const saved = renamed ? this.saved(terminalId) : undefined
    if (!saved) throw new DomainError("TERMINAL_NOT_FOUND")
    for (const watcher of this.watchers.keys()) watcher.changed(this.savedSummary(saved))
  }

  get(terminalId: string): TerminalSummary {
    return { ...this.record(terminalId).summary }
  }

  write(input: { terminalId: string; data: string }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    // While the doorbell's test paste, or an answer's keys, are on screen, the person's
    // keys wait their turn; the terminal's own reports never do.
    const held = record.held?.input ? record.held : undefined
    if (held?.input) {
      const { reports, typed } = splitReports(
        input.data,
        this.reportingOf(record),
        held.deferred === true,
      )
      if (reports) record.process.write(reports)
      // An answer's hold drops the mouse's wheel and motion reports it was given back as
      // `mouse`, never replaying them.
      if (typed) {
        // An answer's hold may drop them: they count once they are delivered.
        if (!held.deferred) this.keyed(record, typed)
        held.input.push(typed)
      }
      return
    }
    this.keyed(record, input.data)
    // node-pty accepts each write synchronously; no input is retried after an uncertain delivery.
    record.process.write(input.data)
  }

  /**
   * Gives the terminal's agent a prompt as the person would paste and submit it (see
   * `Prompts`), once those before it in the terminal's input queue are done.
   */
  async prompt(input: { terminalId: string; text: string }): Promise<void> {
    return await this.prompts.prompt(input.terminalId, input.text)
  }

  /**
   * Answers a request waiting on the person through its dialog in the agent's TUI, as the
   * person would with its keys (see `Answers`). No message of the person's, nor a doorbell
   * ring, comes between the answer and the words that follow it.
   */
  answer(input: { terminalId: string; request: string; answer: RequestAnswer }): Promise<void> {
    return this.answers.answer(input.terminalId, input.request, input.answer)
  }

  /**
   * Presses Escape in the terminal's agent as the person would, which stops its turn, and
   * leaves its box as it was before: where the harness put the turn's prompt back in it
   * (Claude Code, before any reply), it is cleared, only when the box holds exactly it and
   * nothing else, read by the harness's box adapter; where messages the person queued
   * behind the turn came back into the box (Antigravity's Escape; Claude Code's second
   * one, the first having sent them as the next turn), they are taken out again and
   * given back as `returned`, for the chat to put in the person's draft. Codex sends them
   * as a steer, which its second Escape stops, and returns none. A box left holding text
   * that could not be cleared with certainty is `BOX_NOT_CLEARED`.
   *
   * Presses it only while the agent's turn is working, once the person's input is no
   * longer held for a prompt's paste or a ring: at an idle prompt Escape does nothing
   * the chat wants, and two of them open Claude Code's rewind picker. Otherwise it
   * resolves having sent nothing, as the turn it was asked to stop is already over. It
   * takes its turn in the terminal's input queue, so its Escape never cuts into a
   * prompt's paste, an answer's keys or a ring's; those of one terminal are each given
   * their settle wait (`InterruptOptions`) after the last to show its turn ended before
   * the next looks.
   */
  async interrupt(input: { terminalId: string }): Promise<InterruptResult> {
    const { terminalId } = input
    this.promptable(terminalId)
    return await this.inputs.run(terminalId, () => this.interrupts.interrupt(terminalId))
  }

  /** The harness of the agent bound to the terminal, or shown at its prompt, as its box reads. */
  private boxOf(record: Record): BoxProfile | undefined {
    const agent = record.binding?.agent ?? this.messaging.shownAgent(record.summary.id)
    return agent === undefined ? undefined : harnesses[agent].box
  }

  /**
   * The record of a terminal whose agent takes the person's keys, or the error saying why
   * not: no agent bound, nor its own prompt shown before its first session binds, or one
   * that waits on the person's answer to a request, whose dialog would take them.
   */
  private promptable(terminalId: string): Record {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(terminalId)
    this.running(record)
    if (!record.binding && this.messaging.shownAgent(terminalId) === undefined)
      throw new DomainError(
        "CONFLICT",
        "No agent is running in this terminal.",
        undefined,
        "no-agent",
      )
    if ((record.activity?.pending.length ?? 0) > 0)
      throw new DomainError(
        "CONFLICT",
        "The agent waits on the person's answer to a request.",
        undefined,
        "pending",
      )
    return record
  }

  /** Which reports the terminal's TUI asked for, as its screen shows. */
  private reportingOf(record: Record) {
    const { modes } = record.screen
    return {
      mouse: mouseReporting(modes.mouseTrackingMode, record.mouseEncoding()),
      focus: modes.sendFocusMode,
    }
  }

  /**
   * What the person's keys do beyond reaching the terminal, for what watches them: whether
   * a request waits on them, and what they did to the agent's box, which messaging's
   * delivery decides. The terminal's own reports, such as a focus report or, while the TUI
   * asked for them, the mouse's scroll, are no keys.
   */
  private keyed(record: Record, data: string): void {
    const queueKey = record.binding ? harnesses[record.binding.agent].messaging.queueKey : undefined
    const keys = keysOf(data, queueKey, this.reportingOf(record))
    if (keys.length === 0) return
    // A prompt whose trust is still being checked is no longer known empty after a key.
    record.titles = (record.titles ?? 0) + 1
    // Typing before the shell resumes its agent cancels the resume, so the shell gets
    // what was typed. A cancelled resume leaves its session free for another terminal.
    const claim = record.resumeClaim
    if (this.cancelResume(record)) {
      record.startupRuns = false
      // The person took the terminal over before its agent ever ran: nothing to lead.
      this.endLead(record)
      if (claim && this.claims.get(claim) === record.summary.id) this.claims.delete(claim)
    }
    if (/[\r\n]/.test(data)) record.submitted = true
    // A line with something on it is a command; Enter on an empty prompt is not.
    const line = afterKeys(record.line, data)
    record.line = line.line
    if (line.entered) record.lineEntered = true
    if (keys.some(({ kind }) => kind === "enter") && this.readyOf(record)) this.readyEnter(record)
    this.messaging.keys(
      record.summary.id,
      keys.map(({ kind }) => kind),
      (record.activity?.pending.length ?? 0) > 0,
    )
    this.escaped(record)
    if (this.messaging.untrustedAgent(record.summary.id)) this.recheckTrust(record)
  }

  /** The record of a terminal that is running, if it is. */
  private live(terminalId: string): Record | undefined {
    const record = this.records.get(terminalId)
    return record && !record.exitQueued && record.summary.exit === null ? record : undefined
  }

  /** What murmur reads of the terminals and writes to them. */
  private murmurHost(): MurmurHost {
    return {
      subject: (terminalId) => {
        const record = this.live(terminalId)
        return record && murmurSubject(record)
      },
      subjects: () =>
        [...this.records.values()].flatMap((record) =>
          this.live(record.summary.id) ? [murmurSubject(record)] : [],
        ),
      facts: (terminal) => this.peers.facts(terminal),
      screen: async (terminalId) => {
        const shown = await this.shellScreenOf(terminalId)
        const screen = shown?.text
        return (
          screen && {
            rows: screen.rows,
            alternate: screen.alternate,
            ...(shown.commandRow !== undefined && { commandRow: shown.commandRow }),
            ...(screen.wrapped && { wrapped: screen.wrapped }),
            ...(screen.continues && { continues: screen.continues }),
          }
        )
      },
      items: (agent) => harnesses[agent].transcripts?.items,
      projectFolder: (sessionId) => this.projectFolder(sessionId),
      described: (terminalId, description) => {
        const record = this.live(terminalId)
        if (!record) return
        record.naming = murmured(record.naming, description.title)
        this.retitle(record)
        this.save(record, false)
      },
      headlined: (terminalId, { requestId, askedAt }, text) => {
        const record = this.live(terminalId)
        if (!record?.activity || !murmurHeadline.safeParse(text).success) return
        const next = withHeadline(record.activity, requestId, askedAt, text)
        if (!next) return
        record.activity = next
        this.publishAgent(record, false)
      },
      gisted: (terminalId, at, gist) => {
        const record = this.live(terminalId)
        const parsed = murmurGist.safeParse({ text: gist.text, asks: gist.asks })
        if (!record?.activity || !parsed.success) return
        const next = withGist(record.activity, at, parsed.data)
        if (!next) return
        record.activity = next
        this.publishAgent(record, false)
      },
      fileHead: async (path) =>
        (await readPlanFile(path).catch(() => undefined))?.text.slice(0, 16 * 1024) ?? null,
      cleared: () => {
        // Murmur is off or gone: its titles go, running terminals' and saved ones', and the
        // headlines and gists it wrote.
        for (const record of this.records.values()) {
          const next = record.activity && withoutNotes(record.activity)
          if (next) {
            record.activity = next
            this.publishAgent(record, false)
          }
        }
        for (const record of this.records.values()) {
          if (record.naming.murmur === null) continue
          record.naming = { ...record.naming, murmur: null }
          this.retitle(record)
          this.save(record, false)
        }
        // Kept terminals no longer running still show to clients as saved summaries.
        let changed: readonly string[] = []
        this.persisting(() => {
          changed = this.options.records?.clearMurmurTitles() ?? []
        })
        for (const id of changed) {
          const saved = this.records.has(id) ? undefined : this.saved(id)
          if (saved)
            for (const watcher of this.watchers.keys()) watcher.changed(this.savedSummary(saved))
        }
      },
    }
  }

  /**
   * A plain shell's screen as murmur is shown it: the screen, and the row the last command
   * was typed on (see `commandRowOf`), read together once the screen has drawn.
   */
  private async shellScreenOf(
    terminalId: string,
  ): Promise<{ text: ScreenText; commandRow?: number } | undefined> {
    const record = this.live(terminalId)
    if (!record) return undefined
    const { process: child } = record
    const shown = await this.enqueue(record, () => {
      const commandRow = commandRowOf(record)
      return { text: readScreen(record.screen), ...(commandRow !== undefined && { commandRow }) }
    })
    return record.process === child && this.live(terminalId) ? shown : undefined
  }

  /**
   * Keeps the line of the prompt just reported (the parser runs this with the cursor where
   * it is drawn). The prompt before it is kept if a command was entered there, else
   * dropped: it names no command.
   */
  private markPrompt(record: Record, entered: boolean): void {
    if (!entered) record.prompts.pop()?.dispose()
    const marker = record.screen.registerMarker(0)
    if (!marker) return
    record.prompts.push(marker)
    while (record.prompts.length > 2) record.prompts.shift()?.dispose()
  }

  /** Disposes the prompt markers, as when the shell ends or is replaced. */
  private forgetPrompts(record: Record): void {
    for (const marker of record.prompts) marker.dispose()
    record.prompts = []
  }

  /** The screen of a running terminal once it has drawn what its shell already sent. */
  private async screenOf(terminalId: string): Promise<ScreenText | undefined> {
    const record = this.live(terminalId)
    if (!record) return undefined
    const { process: child } = record
    const text = await this.enqueue(record, () => readScreen(record.screen))
    return record.process === child && this.live(terminalId) ? text : undefined
  }

  /**
   * Holds the person's input to a running terminal for at most `budget.inputMs`, and the app's
   * resizes until the hold settles (see `InputQueueHost.hold`). The queue gives one piece of
   * work the terminal at a time, so none holds it in force: only the resizes of the one
   * before may be, which this hold takes over.
   */
  private holdInput(terminalId: string, budget: HoldBudget): InputHold {
    const live = (id: string) => this.live(id)
    const record = live(terminalId)
    const none = {
      release: () => {},
      settle: () => {},
      settleAfter: () => {},
      holding: () => false,
      discard: () => {},
    }
    if (!record || record.held?.input) return none
    const held: NonNullable<Record["held"]> = {
      input: [],
      size: record.held?.size ?? null,
      ...(record.held?.notBefore !== undefined && { notBefore: record.held.notBefore }),
      ...(budget.deferred && { deferred: true }),
    }
    record.held = held
    let lapse: ReturnType<typeof setTimeout> | undefined
    const release = () => {
      clearTimeout(inputCap)
      const { input } = held
      if (record.held !== held || !input) return
      held.input = null
      if (input.length === 0 || live(terminalId) !== record) return
      if (held.deferred) this.keyed(record, input.join(""))
      record.process.write(input.join(""))
    }
    const settle = () => {
      release()
      if (record.held !== held) return
      // Taken over from a hold whose last key was pressed lately: the resizes keep waiting
      // until it has lapsed, as one landing as a turn starts crashed Codex.
      const wait = (held.notBefore ?? 0) - Date.now()
      if (wait > 0) {
        clearTimeout(lapse)
        lapse = setTimeout(settle, wait)
        lapse.unref()
        return
      }
      finish()
    }
    const finish = () => {
      release()
      clearTimeout(sizeCap)
      clearTimeout(lapse)
      if (record.held !== held) return
      record.held = null
      if (live(terminalId) !== record) return
      // Only for the attachment still in control: one that took over meanwhile, or
      // the same window attached anew, was told the size in force and asks its own.
      const { size } = held
      if (
        !size ||
        record.terminal.controller !== size.owner ||
        record.terminal.attachment(size.owner) !== size.attachment
      )
        return
      try {
        this.applySize(record, size)
      } catch {
        // A shell that exited meanwhile takes no size; its exit is handled in turn.
      }
    }
    // A ring or a prompt takes well under these; should it not, the person's keys, then
    // the app's sizes, go on.
    const inputCap = setTimeout(release, budget.inputMs)
    inputCap.unref()
    // Past the input's own cap, as an answer's hold needs, the resizes stay held too.
    const sizeCap = setTimeout(finish, budget.sizeMs)
    sizeCap.unref()
    return {
      release,
      settle,
      settleAfter: (ms) => {
        held.notBefore = Date.now() + ms
        settle()
      },
      holding: () => record.held === held && held.input !== null && live(terminalId) === record,
      discard: () => {
        if (held.input) held.input.length = 0
      },
    }
  }

  /** What prompts ask of the terminals and messaging. */
  private promptHost(): PromptHost {
    return {
      admit: (terminalId) => {
        const profile = this.boxOf(this.promptable(terminalId))
        // No harness to read its box, no prompt: nothing tells where the text would land.
        if (!profile)
          throw new DomainError(
            "CONFLICT",
            "No agent is running in this terminal.",
            undefined,
            "no-agent",
          )
        return profile
      },
      bound: (terminalId) => {
        const record = this.live(terminalId)
        return record === undefined || record.binding !== null
      },
      ringing: (terminalId) => this.messaging.ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => {
        const record = this.live(terminalId)
        if (!record) return false
        this.keyed(record, data)
        record.process.write(data)
        return true
      },
    }
  }

  private interruptHost(): InterruptHost {
    return {
      admit: (terminalId) => void this.promptable(terminalId),
      working: (terminalId) => this.live(terminalId)?.activity?.state === "working",
      alive: (terminalId) => this.live(terminalId) !== undefined,
      profile: (terminalId) => {
        const record = this.live(terminalId)
        return record && this.boxOf(record)
      },
      prompt: (terminalId) => this.messaging.personPrompt(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => {
        const record = this.live(terminalId)
        if (!record) return false
        this.keyed(record, data)
        record.process.write(data)
        return true
      },
      write: (terminalId, data) => {
        const record = this.live(terminalId)
        if (!record) return false
        record.process.write(data)
        return true
      },
    }
  }

  /** What the dialog adapters need of a pending request: what it asks, and where. */
  private factsOf(record: Record, request: Activity["pending"][number]): RequestFacts {
    return {
      kind: request.kind,
      tool: request.toolName,
      input: request.input,
      cwd: request.cwd ?? record.summary.cwd,
    }
  }

  /** The request of a terminal's bound agent that a ref names, with its facts. */
  private waiting(record: Record, ref: string) {
    const { binding, activity } = record
    if (!binding || !activity) return undefined
    const request = activity.pending.find((each) => requestRef(binding, each) === ref)
    return request && { binding, request }
  }

  /** What answering requests asks of the terminals and the dialogs read. */
  private answerHost(): AnswerHost {
    return {
      request: (terminalId, ref) => {
        if (this.stopping) throw new DomainError("CLOSING")
        const record = this.record(terminalId)
        this.running(record)
        const found = this.waiting(record, ref)
        if (!found) return undefined
        const { binding, request } = found
        return {
          actor: request.actor,
          facts: this.factsOf(record, request),
          adapter: harnesses[binding.agent].dialogs,
          others: (record.activity?.pending ?? [])
            .filter((each) => each !== request)
            .map((each) => ({
              ref: requestRef(binding, each),
              actor: each.actor,
              facts: this.factsOf(record, each),
              askedAt: each.askedAt,
            })),
        }
      },
      ringing: (terminalId) => this.messaging.ringing(terminalId),
      screen: (terminalId) => this.screenOf(terminalId),
      type: (terminalId, data) => {
        const record = this.live(terminalId)
        if (!record) return false
        this.keyed(record, data)
        record.process.write(data)
        return true
      },
      prompt: (entry, terminalId, text) => this.prompts.promptIn(entry, terminalId, text),
      working: (terminalId) => this.records.get(terminalId)?.activity?.state === "working",
      turnStartedAt: (terminalId) => {
        const activity = this.records.get(terminalId)?.activity
        return activity?.state === "working" ? activity.turnAt : undefined
      },
      closed: (terminalId, ref) => this.dialogs.closed(terminalId, ref),
      shown: (terminalId, ref) => {
        const dialog = this.dialogs.shown(terminalId, ref)
        return dialog !== null && dialog.type !== "raw"
      },
      answered: (terminalId, ref) => this.dialogs.answered(terminalId).has(ref),
      raw: (terminalId, ref) => this.dialogs.shown(terminalId, ref)?.type === "raw",
      lock: (terminalId, ref, reason, rows) => {
        this.dialogs.lock(terminalId, ref, reason, rows)
      },
      done: (terminalId, ref) => {
        this.dialogs.done(terminalId, ref)
        // A request only the screen told has no hook to say it was answered.
        const record = this.records.get(terminalId)
        const found = record && this.waiting(record, ref)
        if (record && found?.request.screen) this.clearScreenRequest(record, found.request)
      },
      busy: (terminalId, on) => {
        if (on) this.dialogs.begin(terminalId)
        else this.dialogs.end(terminalId)
      },
    }
  }

  /** What the dialogs tracker asks of the terminals. */
  private dialogsHost(): DialogsHost {
    return {
      pending: (terminalId) => {
        const record = this.live(terminalId)
        const { binding, activity } = record ?? {}
        if (!record || !binding || !activity) return undefined
        return {
          agent: binding.agent,
          requests: activity.pending.map((request) => ({
            ref: requestRef(binding, request),
            actor: request.actor,
            facts: this.factsOf(record, request),
            subject: request.subject,
            screen: request.screen === true,
            askedAt: request.askedAt,
          })),
        }
      },
      adapter: (agent) => harnesses[agent].dialogs,
      screen: (terminalId) => this.screenOf(terminalId),
      ask: (terminalId, request) => {
        const record = this.live(terminalId)
        const { binding } = record ?? {}
        if (!record || !binding) return
        const { agent, sessionId, instance } = binding
        const fact: ActivityEvent = {
          type: "attention-requested",
          agent,
          sessionId,
          instance,
          startedAt: Date.now(),
          // One per time it shows: the same while it does.
          requestId: `screen:${request.tool}:${randomUUID()}`,
          actor: null,
          toolName: request.tool,
          kind: request.kind,
          subject: request.subject,
          choices: [],
          input: request.input,
          screen: true,
        }
        if (this.applyFact(record, fact)) this.publishAgent(record, false)
      },
      clear: (terminalId, ref) => {
        const record = this.live(terminalId)
        const found = record && this.waiting(record, ref)
        if (record && found) this.clearScreenRequest(record, found.request)
      },
      changed: (terminalId) => {
        const record = this.records.get(terminalId)
        if (record) this.detailed(record)
      },
    }
  }

  /** A request only the screen told no longer waits: its screen is gone, or it was answered. */
  private clearScreenRequest(record: Record, request: Activity["pending"][number]): void {
    const { binding } = record
    if (!binding) return
    const { agent, sessionId, instance } = binding
    const fact: ActivityEvent = {
      type: "attention-resolved",
      agent,
      sessionId,
      instance,
      startedAt: Date.now(),
      requestId: request.requestId,
      actor: null,
      toolName: request.toolName,
      loose: false,
      outcome: "allowed",
    }
    if (this.applyFact(record, fact)) this.publishAgent(record, false)
  }

  /**
   * Whether the activity says a turn or subagents run, where that outweighs what messaging
   * knows: a Settled or Ready terminal made so by a Stop or a session's start stands against
   * an activity that lingers; every other, and any made so by the screen alone, does not.
   */
  private working(terminalId: string, activity: Parameters<typeof busy>[0]): boolean {
    const state = this.messaging.delivery(terminalId)?.state
    const known = (state === "settled" || state === "ready") && !this.messaging.byScreen(terminalId)
    return !known && busy(activity)
  }

  /** What the doorbell asks of the terminals and messaging. */
  private ringHost(): DoorbellHost {
    const live = (terminalId: string) => this.live(terminalId)
    return {
      // A request asked after the turn's Stop waits on the person though messaging has the
      // terminal Settled: the line would land in its dialog.
      ringable: (terminalId) => {
        const record = live(terminalId)
        return (
          record !== undefined &&
          (record.activity?.pending.length ?? 0) === 0 &&
          !this.working(terminalId, record.activity) &&
          !this.stopping &&
          this.messaging.ringable(terminalId)
        )
      },
      settledSince: (terminalId) => this.messaging.settledSince(terminalId),
      ring: (terminalId, nonce) => {
        const record = live(terminalId)
        return (
          record !== undefined &&
          !this.working(terminalId, record.activity) &&
          this.messaging.ring(terminalId, nonce)
        )
      },
      ringing: (terminalId) => this.messaging.ringing(terminalId),
      ready: (terminalId) => this.messaging.ready(terminalId),
      // Idle but not Ready by its state, with messages waiting: its screen is looked at.
      // Never while its activity says a turn or subagents run (a spinner is no calm), and
      // for a Settled or Ready one only to say a request waits on the person.
      stalled: (terminalId) => {
        const record = live(terminalId)
        if (!record) return false
        if (this.working(terminalId, record.activity)) {
          if (this.messaging.stalled(terminalId) || this.messaging.idleWaiting(terminalId))
            tracer.sink?.(
              terminalId,
              `not looked at: activity ${record.activity?.state}, ${record.activity?.subagents.length ?? 0} subagents, background ${JSON.stringify(record.activity?.background)}`,
            )
          return false
        }
        return (
          this.messaging.stalled(terminalId) ||
          ((record.activity?.pending.length ?? 0) > 0 && this.messaging.idleWaiting(terminalId))
        )
      },
      stamp: (terminalId) => this.messaging.stamp(terminalId),
      barred: (terminalId) => this.messaging.queueBar(terminalId),
      // The agent's own box, read by its harness off the calm screen: empty and taking a
      // prompt makes an idle Fresh, Drafting or Unknown terminal Ready (see
      // docs/agent-messaging.md, "The doorbell"); anything else says why it is not.
      reading: (terminalId, screen) => {
        const record = live(terminalId)
        if (!record) return "dialog"
        if ((record.activity?.pending.length ?? 0) > 0) return "asking"
        if (this.working(terminalId, record.activity)) return "draft"
        const profile = this.boxOf(record)
        const box = profile?.read(screen)
        if (!profile || profile.overlay(screen)) return "dialog"
        // Before its prompt draws, a new session shows no box yet: nothing to say.
        if (!box)
          return this.messaging.delivery(terminalId)?.state === "fresh" ? "starting" : "dialog"
        if (box.mode !== "prompt") return "draft"
        // A picker's row starts with the box's marker too (`❯ 1. Yes`): not a box.
        if (/^\d+[.)]\s/.test(box.text.trimStart())) return "dialog"
        return isEmpty(box) && !profile.queued(screen) ? "empty" : "draft"
      },
      // The line a failed ring left, all the box holds, which the person has not touched.
      leftover: (terminalId, screen) => {
        const record = live(terminalId)
        if (!record || !this.messaging.ours(terminalId)) return undefined
        const profile = this.boxOf(record)
        const box = profile?.read(screen)
        if (!profile || !box || box.mode !== "prompt" || profile.overlay(screen)) return undefined
        return leftoverNonce(box.text)
      },
      ringLeftover: (terminalId, nonce) => this.messaging.ringLeftover(terminalId, nonce),
      emptied: (terminalId, readAt) => {
        const delivery = this.messaging.delivery(terminalId)
        const record = live(terminalId)
        if (delivery && record && !this.working(terminalId, record.activity))
          this.messaging.emptied(terminalId, delivery.epoch, readAt)
      },
      blocked: (terminalId, waits) => this.messaging.blocked(terminalId, waits),
      ringFailed: (terminalId, nonce, ours) => this.messaging.ringFailed(terminalId, nonce, ours),
      screen: (terminalId) => this.screenOf(terminalId),
      // The agent's box must show, empty and taking a prompt, as a prompt's must: on Windows
      // a TUI that reads the console's keys gets a bracketed paste as keys, and everywhere a
      // key or a view since the calm may have left text there or something else in its
      // place, so the ring looks again as it begins.
      inputBox: (terminalId: string, screen: ScreenText) => {
        const record = live(terminalId)
        const profile = record && this.boxOf(record)
        const box = profile?.read(screen)
        return (
          box !== undefined &&
          box.mode === "prompt" &&
          isEmpty(box) &&
          profile?.overlay(screen) === false
        )
      },
      foreground: async (terminalId) => {
        const record = live(terminalId)
        if (!record) return undefined
        // A prompt shown before any session bound: its agent must still hold the
        // terminal, as the shell's prompt may have come back unseen (a nested shell).
        const shown = record.binding ? undefined : this.messaging.shownAgent(terminalId)
        if (shown) return foregroundRuns(record.process.pid, shown)
        const { binding } = record
        const instance = binding?.instance
        if (!instance) return undefined
        // The bound agent left unseen: no ring for its session, whatever holds the terminal
        // now, and its binding ends, in turn with the reports.
        if (!alive(instance)) {
          void this.queue(
            terminalId,
            () => {
              if (record.binding === binding) this.endExited(record)
              return Promise.resolve()
            },
            undefined,
          )
          return false
        }
        const [held, own] = await Promise.all([
          terminalForeground(record.process.pid),
          processGroup(Number(instance)),
        ])
        return held === undefined || own === undefined ? undefined : held === own
      },
      resizedAt: (terminalId) => live(terminalId)?.resizedAt ?? 0,
      write: (terminalId, data) => {
        const record = live(terminalId)
        if (!record) return false
        record.process.write(data)
        return true
      },
    }
  }

  resize(input: { terminalId: string; cols: number; rows: number }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    // While the doorbell rings, a resize would redraw the screen its paste is checked on,
    // or land as its turn starts: the latest waits for the ring's hold to settle.
    if (record.held) {
      record.held.size = {
        cols: input.cols,
        rows: input.rows,
        owner: ownerId,
        attachment: record.terminal.attachment(ownerId),
      }
      return
    }
    this.applySize(record, input)
  }

  private applySize(record: Record, { cols, rows }: { cols: number; rows: number }): void {
    // Only a new size redraws the screen, as a window attaching again may ask for the same.
    if (cols !== record.summary.cols || rows !== record.summary.rows) record.resizedAt = Date.now()
    record.process.resize(cols, rows)
    void this.enqueue(record, () => {
      record.screen.resize(cols, rows)
      record.summary = { ...record.summary, cols, rows }
      this.announce(record)
      this.emit(record, { type: "resized", cols, rows })
    })
  }

  /**
   * Starts a fresh shell in an exited terminal, keeping its id, session and directory.
   * The caller gains control, and needs it unless nobody holds it.
   * Viewers attach again for the new screen. A failed start leaves the terminal exited.
   */
  async restart(
    input: { terminalId: string; resume?: AgentName | undefined } & Size,
    ownerId: string,
  ): Promise<TerminalSummary> {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(input.terminalId)
    if (record.closed || this.closingSessions.has(record.summary.sessionId))
      throw new DomainError("TERMINAL_NOT_FOUND")
    if (record.summary.exit === null || record.restarting)
      throw new DomainError("CONFLICT", "Only an exited terminal can restart.")
    if (record.terminal.controller !== undefined && record.terminal.controller !== ownerId)
      throw new DomainError("CONTROL_IN_USE")
    record.restarting = true
    const pending = this.pending(ownerId)
    try {
      const environment = this.shellEnvironment()
      // The last directory, or where the terminal started once that is gone.
      const cwd = await this.directory(record.summary.cwd).catch(() =>
        this.directory(record.origin),
      )
      const shell = await this.executable(cwd, environment)
      const integration = await this.shellIntegration()
      const connected = await this.connected(input.resume)
      const env = await environment
      // The swap waits for the old shell's queued work, which still uses the old screen.
      return await this.enqueue(record, () => {
        if (this.stopping) throw new DomainError("CLOSING")
        // Closed meanwhile, or its project is closing: no shell starts in it again.
        if (
          record.closed ||
          this.records.get(input.terminalId) !== record ||
          this.closingSessions.has(record.summary.sessionId)
        )
          throw new DomainError("TERMINAL_NOT_FOUND")
        const resume =
          input.resume &&
          this.resumable(
            record.summary.id,
            input.resume,
            record.agents[input.resume]?.sessionId,
            connected,
          )
        const started = this.spawn(
          shell,
          cwd,
          input,
          integration,
          env,
          resume ? { command: resume.argv.join(" ") } : undefined,
        )
        if (resume && started.resumes) {
          this.claims.set(resume.key, record.summary.id)
          started.resumeClaim = resume.key
        }
        this.forgetPrompts(record)
        const earlier =
          this.transcripts && !started.resumes
            ? transcriptOf(record.screen, this.options.transcriptChars)
            : null
        // Earlier attachments ended at the exit; any still draining are dropped, and any
        // earlier cursor gets a fresh snapshot.
        record.terminal.restarted(pending.released ? undefined : ownerId)
        this.dispose(record)
        Object.assign(record, started, {
          summary: {
            ...record.summary,
            cwd,
            cols: input.cols,
            rows: input.rows,
            exit: null,
            process: shellProcess(shell),
            run: record.summary.run + 1,
            agent: null,
            ready: null,
            activity: null,
            telemetry: null,
          } satisfies TerminalSummary,
          foreground: undefined,
          binding: null,
          suspended: null,
          root: null,
          held: null,
          seenEntry: undefined,
          shellName: shellProcess(shell)?.name,
          activity: null,
          telemetry: null,
          watching: null,
          transcript: null,
          exitQueued: false,
          closing: undefined,
          submitted: started.resumes,
          startupRuns: started.resumes,
          readyEntered: false,
          // Delivery epochs start over with the new shell's registration.
          boxDoubtEpoch: undefined,
          prompts: [],
          line: emptyLine,
          lineEntered: started.resumes,
        })
        // The earlier shell's screen shows above the new one's.
        if (earlier) this.show(record, earlier, null)
        // Restarted to resume the worker's agent session, it stays led; restarted as a plain
        // shell, there is no agent left to lead.
        if (!started.resumes) this.endLead(record)
        // The earlier shell's job and what murmur kept of it are not the new one's.
        this.murmur?.gone(record.summary.id)
        this.register(record, input.resume ?? null)
        this.listen(record)
        this.announce(record)
        this.sampleProcesses()
        return { ...record.summary }
      })
    } finally {
      record.restarting = false
      this.complete(ownerId, pending)
    }
  }

  /**
   * Forgets the terminal, then ends its shell. A close is for good: it goes whatever
   * window controls it, and what restores it goes first, so a runner that stops before
   * the shell has ended, as the app quits, keeps nothing of it to bring back.
   */
  async close(input: { terminalId: string }): Promise<void> {
    if (this.stopped) throw new DomainError("CLOSING")
    this.closedIds.add(input.terminalId)
    const record = this.records.get(input.terminalId)
    if (!record) {
      // A terminal kept only as saved closes by forgetting it.
      const saved = this.saved(input.terminalId)
      this.forget(input.terminalId)
      if (!saved) throw new DomainError("TERMINAL_NOT_FOUND")
      for (const watcher of this.watchers.keys()) watcher.removed(saved)
      return
    }
    this.closeForGood(record)
    await this.terminate(record)
    this.remove(record)
    // What its programs left on their way out, as an agent registering again, goes too.
    this.forget(input.terminalId)
  }

  /** Whether the session's terminal with this handle is closing, its shell not yet ended. */
  private closingHere(sessionId: string, handle: string): boolean {
    return [...this.records.values()].some(
      ({ closed, summary }) =>
        closed && summary.sessionId === sessionId && summary.handle === handle,
    )
  }

  /**
   * Starts closing a running terminal for good: watchers hear it is gone, nothing
   * announces or saves it again, and what restores it is forgotten before its shell ends.
   */
  private closeForGood(record: Record): void {
    if (record.closed) return
    record.closed = true
    this.closedIds.add(record.summary.id)
    for (const watcher of this.watchers.keys()) watcher.removed(record.summary)
    // The agent sessions it claimed stay its own until its shell has ended, so none
    // resumes elsewhere while it still runs there.
    this.forget(record.summary.id, { claims: false })
  }

  /**
   * Closes every terminal of a project's sessions, running or kept only as saved, as
   * `close` does but whoever controls them, then forgets its agents' messages: the
   * project is going. Its records are the caller's to delete.
   */
  async closeProject(projectId: string, sessionIds: readonly string[]): Promise<void> {
    if (this.stopping) throw new DomainError("CLOSING")
    const sessions = new Set(sessionIds)
    // Marked first, so a restart or create under way can't start a shell behind the close,
    // and left marked once closed: the project and its sessions are going for good.
    for (const sessionId of sessions) this.closingSessions.add(sessionId)
    try {
      await this.closeSessions(sessions)
    } catch (error) {
      for (const sessionId of sessions) this.closingSessions.delete(sessionId)
      throw error
    }
    // Shutting down meanwhile: the project, and what of its terminals was only saved, stay
    // for the next runner to remove.
    if (this.stopping) throw new DomainError("CLOSING")
    this.asks.forgetProject(projectId)
    this.messaging.forgetProject(projectId)
  }

  /** The project stays after all, as its removal failed: terminals start in it again. */
  projectKept(sessionIds: readonly string[]): void {
    for (const sessionId of sessionIds) this.closingSessions.delete(sessionId)
  }

  /** Closes every terminal of the sessions, running or kept, whoever controls them. */
  private async closeSessions(sessions: ReadonlySet<string>): Promise<void> {
    const running = [...this.records.values()].filter(({ summary }) =>
      sessions.has(summary.sessionId),
    )
    for (const record of running) this.closeForGood(record)
    await Promise.all(
      running.map(async (record) => {
        await this.terminate(record)
        this.remove(record)
        this.forget(record.summary.id)
      }),
    )
    for (const sessionId of sessions) {
      let kept: readonly ListedTerminal[] = []
      this.persisting(() => {
        kept = this.options.records?.terminals(sessionId) ?? []
      })
      for (const terminal of kept) {
        this.closedIds.add(terminal.id)
        this.forget(terminal.id)
        for (const watcher of this.watchers.keys()) watcher.removed(terminal)
      }
      this.handles.delete(sessionId)
    }
  }

  /** Forgets what restores the terminal, and unless told not to, the sessions it claimed. */
  private forget(terminalId: string, { claims = true } = {}): void {
    // Its items go first, so watchers hear of each before its record cascades them away.
    this.options.items?.terminalClosed(terminalId)
    this.messaging.unregister(terminalId)
    this.asks.reconcile(terminalId)
    this.doorbell?.forget(terminalId)
    this.dialogs.forget(terminalId)
    this.murmur?.gone(terminalId)
    if (claims)
      for (const [key, claimant] of this.claims)
        if (claimant === terminalId) this.claims.delete(key)
    this.openers.delete(terminalId)
    // Forgotten while the runner stops too, as a close then still stands.
    this.persisting(() => this.options.records?.removeTerminal(terminalId), "untilStopped")
  }

  /**
   * Where a terminal kept by the runner is, running or saved, as items shown in it or
   * placed on it need: its session, handle, directory and project folder.
   */
  place(terminalId: string): TerminalPlace | undefined {
    const live = this.records.get(terminalId)
    const terminal = live?.summary ?? this.saved(terminalId)
    if (!terminal) return undefined
    return {
      terminalId,
      sessionId: terminal.sessionId,
      handle: terminal.handle,
      cwd: terminal.cwd,
      project: this.projectFolder(terminal.sessionId),
    }
  }

  /**
   * What a running terminal's dictation hint is made of (see `dictationHint`), but its
   * project's name, with the files shown in its bar. Undefined for a terminal not running
   * here.
   */
  async hintFacts(terminalId: string): Promise<Omit<HintFacts, "project"> | undefined> {
    const record = this.records.get(terminalId)
    if (!record) return undefined
    const facts = await this.peers.hint(record, this.options.items?.bar(terminalId) ?? [])
    // The session's open terminals' handles, in the order they were given, so dictation
    // spells them.
    const handles = [...this.records.values()]
      .filter(({ closed, summary }) => !closed && summary.sessionId === record.summary.sessionId)
      .map(({ summary }) => summary.handle)
    return { ...facts, handles }
  }

  /**
   * A plan presented as text, as the terminal it came from has it live while it still
   * runs the plan's session: the latest its actor presented, and when.
   */
  livePlan(item: ItemRecord): PlanText | undefined {
    const { plan } = item
    const record = this.records.get(item.from.terminalId)
    const { binding } = record ?? {}
    if (!plan || !binding || binding.agent !== plan.agent || binding.sessionId !== plan.session)
      return undefined
    const live = record?.activity?.plans.find(({ actor }) => actor === plan.actor)
    if (live?.source.kind !== "text") return undefined
    return { text: live.source.text, truncated: live.source.truncated, changedAt: live.at }
  }

  /** The session `agent` last reported in the terminal, live or saved; null when none. */
  reportedSession(terminalId: string, agent: AgentName): string | null {
    const live = this.records.get(terminalId)
    return (live ?? this.saved(terminalId))?.agents[agent]?.sessionId ?? null
  }

  /** Whether `agent` is connected; false without one, or when that cannot be told. */
  private async connected(agent: AgentName | undefined): Promise<boolean> {
    return agent !== undefined && (await this.options.connected(agent).catch(() => false))
  }

  /**
   * The command that resumes `agent`'s `session` in the terminal, and the claim to
   * record once a shell runs it; undefined when it may not (see `resumeAvailability`).
   * One session resumes in one terminal: not while another terminal has it bound, nor
   * once another terminal claimed it, until that terminal closes.
   */
  private resumable(
    terminalId: string,
    agent: AgentName,
    session: string | undefined,
    connected: boolean,
  ): { argv: readonly string[]; key: string } | undefined {
    const { resume } = harnesses[agent]
    const key = `${agent}:${session}`
    const claimant = this.claims.get(key)
    const bound = [...this.records.values()].some(
      (other) =>
        other.summary.id !== terminalId &&
        other.binding?.agent === agent &&
        other.binding.sessionId === session,
    )
    const inUse = (claimant !== undefined && claimant !== terminalId) || bound
    const availability = resumeAvailability({
      agent,
      resumes: resume !== undefined,
      connected,
      session,
      inUse,
    })
    if (availability.state !== "ready" || !resume || session === undefined) return undefined
    return { argv: resume(session), key }
  }

  /**
   * Removes a resume command the shell has not taken yet, so it never runs; true when
   * one was still waiting.
   */
  private cancelResume(record: Record): boolean {
    const file = record.resumeFile
    if (!file) return false
    record.resumeFile = undefined
    try {
      rmSync(file)
      return true
    } catch {
      // Taken meanwhile, or unremovable; the shell removes it as it reads it.
      return false
    }
  }

  /** Forgets every session `agent` reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void {
    this.disconnections.set(agent, (this.disconnections.get(agent) ?? 0) + 1)
    for (const record of this.records.values()) {
      const { [agent]: _forgotten, ...rest } = record.agents
      record.agents = rest
      const agentRan = hasRun(rest)
      // Its binding ends too: a disconnected harness holds no terminal's foreground.
      if (record.binding?.agent === agent) {
        record.binding = null
        record.activity = null
        record.telemetry = null
        this.unwatch(record)
        this.rebound(record)
        record.summary = {
          ...record.summary,
          agentRan,
          agent: null,
          ready: this.readyOf(record),
          activity: null,
          telemetry: null,
        }
        this.announce(record)
      } else if (record.summary.agentRan !== agentRan) {
        record.summary = { ...record.summary, agentRan }
        this.announce(record)
      }
    }
    for (const key of this.claims.keys()) if (key.startsWith(`${agent}:`)) this.claims.delete(key)
    this.persisting(() => this.options.records?.forgetAgent(agent))
  }

  /** The integration for a new shell, with the connected harnesses whose shims it gets. */
  private async shellIntegration(): Promise<
    (Integration & { shims: readonly AgentName[] }) | undefined
  > {
    const integration = await this.integration
    if (!integration) return undefined
    return { ...integration, shims: await this.options.shims().catch(() => []) }
  }

  /** Turning transcripts off forgets every saved one; turning them on saves each anew. */
  keepTranscripts(enabled: boolean): void {
    if (this.stopping) throw new DomainError("CLOSING")
    this.transcripts = enabled
    if (enabled) for (const record of this.records.values()) record.changed = true
    if (!enabled) this.persisting(() => this.options.records?.clearTranscripts())
  }

  /** Saves every terminal's changes now, as before the system shuts down. */
  persist(): void {
    for (const record of this.records.values()) if (record.changed) this.save(record, true)
  }

  /**
   * Saves a few changed terminals whose screens were saved longest ago, so the runner
   * never stops for all of them at once; each is saved every `saveMs` or so.
   */
  private persistSome(): void {
    const due = performance.now() - this.options.saveMs
    const waiting = [...this.records.values()]
      .filter((record) => record.changed && record.savedAt <= due)
      .toSorted((a, b) => a.savedAt - b.savedAt)
    for (const record of waiting.slice(0, savesPerTick)) this.save(record, true)
  }

  /** Streams an `attached` marker once established, then snapshot or replay and live events. */
  async *attach(
    input: Attach,
    ownerId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalAttached | TerminalEvent> {
    const record = this.record(input.terminalId)
    const pending = this.pending(ownerId)
    record.pendingAttachments += 1
    let attachment: Attachment | undefined
    const detach = () => {
      if (!attachment) {
        if (signal?.aborted || pending.released) record.terminal.forgo(ownerId)
        return
      }
      if (record.terminal.attachment(ownerId) === attachment) record.terminal.release(ownerId)
    }
    const abort = () => {
      attachment?.cancel()
      detach()
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      await this.enqueue(record, () => {
        if (signal?.aborted || pending.released) return
        if (this.stopping) throw new DomainError("CLOSING")
        // Closed, or closing, while this attachment waited its turn.
        if (record.closed || this.records.get(input.terminalId) !== record)
          throw new DomainError("TERMINAL_NOT_FOUND")
        attachment = record.terminal.attach(ownerId, {
          after: input.afterSequence,
          mode: input.mode ?? "control",
        })
      }).finally(() => {
        record.pendingAttachments -= 1
      })
      if (!attachment) return
      // Tells the client that control or observation is established before any event arrives.
      yield { type: "attached", terminalId: input.terminalId, mode: attachment.mode }
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Each delivery waits for consumption ACKs.
        const event = await attachment.next()
        if (event === undefined) return
        yield { ...event, terminalId: input.terminalId }
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      attachment?.cancel()
      detach()
      this.complete(ownerId, pending)
      this.settle(record)
      this.evict()
    }
  }

  /**
   * Streams a `changed` for every terminal, `synced`, then later changes, until the
   * signal aborts, the owner is released, or the runner shuts down.
   */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<TerminalChange> {
    if (this.stopping) throw new DomainError("CLOSING")
    const watcher = new TerminalWatcher(this.list())
    this.watchers.set(watcher, ownerId)
    const abort = () => watcher.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) watcher.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are delivered in order.
        const change = await watcher.next()
        if (change === undefined) return
        yield change
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      watcher.finish()
      this.watchers.delete(watcher)
    }
  }

  /**
   * What the agent in a terminal does, in detail: a snapshot, then another on each change,
   * until the terminal is closed or `signal` aborts.
   */
  async *detail(terminalId: string, signal?: AbortSignal): AsyncGenerator<AgentDetail> {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(terminalId)
    yield* this.snapshots(this.details, terminalId, this.detailOf(record), signal)
  }

  /**
   * Shows the person what an agent asked to, through Novadeck's MCP server in one of
   * the terminal's shells, on the terminal's own bar (see `CompanionItems.show`). A call
   * without the shell's own token learns nothing more.
   */
  async present(call: Call): Promise<PresentAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token)) return unanswered
    const read = readRequest(call.request)
    if (!read.ok) return read
    const place = this.place(call.terminalId)
    if (!place || !this.options.items) return unanswered
    return this.options.items.show(place, read.request)
  }

  /**
   * Closes what the caller's agent showed on its own terminal's bar, through Novadeck's
   * MCP server (see `CompanionItems.dismiss`). A call without the shell's own token
   * learns nothing more.
   */
  async dismiss(call: Call): Promise<DismissAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.dismiss
    const read = readDismissRequest(call.request)
    if (!read.ok) return read
    const place = this.place(call.terminalId)
    if (!place || !this.options.items) return unansweredCalls.dismiss
    return this.options.items.dismiss(place, read.request)
  }

  /** What the caller's own terminal's bar holds, as its agent asked through Novadeck's MCP server. */
  private showing(call: Call): { ok: true; text: string } | typeof unansweredCalls.showing {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.showing
    if (!this.options.items) return unansweredCalls.showing
    return { ok: true, text: this.options.items.listing(call.terminalId) }
  }

  /**
   * Opens a new terminal beside the caller's, as an agent asked through Novadeck's MCP
   * server in one of the terminal's shells: in a folder, from the terminal's directory,
   * optionally starting a command at its first prompt. The client that lays terminals
   * out opens it (see `requests`), so without one nothing opens. A terminal's agents
   * open a few at most each minute. A call without the shell's own token learns nothing
   * more.
   */
  async open(call: Call): Promise<OpenAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.open
    const read = readOpenRequest(call.request)
    if (!read.ok) return read
    const { request } = read
    const starts = request.command !== undefined || request.agent !== undefined
    // Every check `send` would refuse the task for, before anything starts.
    if (request.agent !== undefined && request.message !== undefined) {
      const refusal = this.messaging.refusal(call.terminalId, request.message, request.agent)
      if (refusal) return refused(refusal)
    }
    if (request.agent !== undefined && !(await this.connected(request.agent)))
      return refused(
        `Novadeck isn't connected to ${agentLabel(request.agent)}, so its hooks couldn't take ` +
          "the task; the user can connect it in Novadeck's preferences.",
      )
    if (starts && !(await this.startsCommands()))
      return refused(
        "Novadeck's shells can't start a command as they open here, as its shell integration " +
          "isn't loaded, so no terminal opened.",
      )
    const folder = request.cwd ?? "."
    const cwd = await this.directory(resolvePath(record.summary.cwd, folder)).catch(() => undefined)
    if (cwd === undefined) return refused(`${folder} isn't a folder a terminal can open in.`)
    const started: { command?: string | undefined; prompted: boolean; nonce?: string } =
      request.agent === undefined
        ? { command: request.command, prompted: true }
        : await this.taskCommand(request.agent, cwd)
    const { command } = started
    // Closed, or the runner stopped, while the folder was looked at.
    if (this.stopping || this.records.get(call.terminalId) !== record) return unansweredCalls.open
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.opened, now, openLimit.windowMs)
    const times = allowOpen(this.opened.get(charged) ?? [], now)
    const all = allowOpen(this.allOpened, now, runnerOpenLimit)
    if (!times || !all)
      return refused(
        "Agents opened as many terminals as they may in the last minute; try again shortly.",
      )
    this.opened.set(charged, times)
    this.allOpened = all
    const asked = await this.opens.ask(
      {
        from: call.terminalId,
        sessionId: record.summary.sessionId,
        cwd,
        ...(command !== undefined && { command }),
        focus: request.focus === true,
      },
      this.options.openMs,
      // The title it asked for is its own, never the person's: the terminal takes it as
      // the client creates it for this request.
      {
        by: record.summary.handle,
        ...(request.title !== undefined && { title: request.title }),
        ...(command !== undefined && { command }),
        // Only an agent opened with a brief is led by the one that opened it.
        withBrief: request.agent !== undefined,
      },
    )
    let task: SendAnswer | undefined
    if (asked.type === "answered" && "terminalId" in asked.answer) {
      this.openers.set(asked.answer.terminalId, charged)
      const opened = this.records.get(asked.answer.terminalId)
      // The task goes to the first session of the agent it starts there, from the opener,
      // which leads that terminal: it is the lead's first message.
      if (opened && request.message !== undefined) {
        // Its first typed entry is this line, where a transcript tells its prompts.
        if (started.prompted && started.nonce) opened.startedWith = started.nonce
        this.save(opened, false)
        task = this.messaging.send(call.terminalId, {
          to: opened.summary.handle,
          text: request.message,
        })
      }
    }
    const answer = this.opening(asked, cwd, command)
    if (!answer.ok || !task) return answer
    return { ...answer, task, ...(!started.prompted && { taskWaits: true as const }) }
  }

  /**
   * The command that starts `agent` with a task: the doorbell's line, with its `nonce`, as
   * its command-line prompt, which it submits once past its startup screens; plain where
   * it may not take one (Antigravity in a folder it doesn't trust), when the task arrives
   * once the person trusts the folder and its prompt shows, rung as any message is.
   */
  private async taskCommand(
    agent: AgentName,
    cwd: string,
  ): Promise<{ readonly command: string; readonly prompted: boolean; readonly nonce: string }> {
    const { messaging } = harnesses[agent]
    const install = await this.options.install(agent).catch(() => undefined)
    const nonce = freshNonce()
    const prompted = await messaging
      .initialPrompt(doorbellLine(nonce), { install, cwd })
      .catch(() => undefined)
    const argv = prompted ?? messaging.start
    // Every word but the line is a plain word; the line holds nothing a shell expands.
    const command = argv
      .map((word) => (/^[\w./-]+$/.test(word) ? word : quotedLine(word)))
      .join(" ")
    return { command, prompted: prompted !== undefined, nonce }
  }

  /** What the agent learns of the client's answer. */
  private opening(asked: Asked, cwd: string, command: string | undefined): OpenAnswer {
    if (asked.type !== "answered") return refused(unopened[asked.type])
    const { answer } = asked
    if ("reason" in answer) return refused(answer.reason)
    const opened = this.records.get(answer.terminalId)
    if (!opened) return unansweredCalls.open
    return {
      ok: true,
      terminalId: answer.terminalId,
      handle: opened.summary.handle,
      title: opened.summary.title,
      cwd,
      ...(command !== undefined && { command }),
    }
  }

  /**
   * Closes another terminal of the caller's project and session, as an agent asked
   * through Novadeck's MCP server by the terminal's exact handle: as the person's close
   * does, it ends the shell, then forgets the terminal, whatever window controls it, and
   * messages still waiting for it are gone. Never the caller's own terminal; a handle
   * not there is refused with every terminal there described. A chain of terminals'
   * agents close a few at most each minute, and all agents a few more. A call without
   * the shell's own token learns nothing more.
   */
  async closePeer(call: Call): Promise<CloseAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.close
    const read = readCloseRequest(call.request)
    if (!read.ok) return read
    const { to } = read.request
    if (to === record.summary.handle) return refused(selfRefusal(to))
    // Already on its way out, and forgotten, as another close ended its shell.
    if (this.closingHere(record.summary.sessionId, to))
      return refused(`${mention(to)} is already closing.`)
    const target = await this.peers.target(record, to)
    if (!target.ok) return target
    // Closed, or the runner stopped, while the terminals were described.
    const closing = this.records.get(target.terminalId)
    if (this.stopping || this.records.get(call.terminalId) !== record || !closing)
      return unansweredCalls.close
    // Already on its way out, as another close ended its shell: nothing more to charge.
    if (closing.closing || closing.closed)
      return refused(`${mention(target.handle)} is already closing.`)
    const now = Date.now()
    const charged = this.openers.get(call.terminalId) ?? call.terminalId
    prune(this.closed, now, closeLimit.windowMs)
    const times = allowClose(this.closed.get(charged) ?? [], now)
    const all = allowClose(this.allClosed, now, runnerCloseLimit)
    if (!times || !all) return refused(spentRefusal)
    this.closed.set(charged, times)
    this.allClosed = all
    const { agent } = target
    const others = this.messaging.waitingFor(target.terminalId, call.terminalId)
    this.closeForGood(closing)
    await this.terminate(closing)
    // The runner began to stop meanwhile: the terminal is closed all the same, but the
    // caller is going too.
    if (this.stopping) return unansweredCalls.close
    this.remove(closing)
    this.forget(target.terminalId)
    const gone = this.messaging.goneFrom(call.terminalId)
    return {
      ok: true,
      handle: target.handle,
      title: closing.summary.title,
      ...(agent !== null && { ran: agentLabel(agent) }),
      ...(gone.length > 0 && { gone }),
      ...(others > 0 && { others }),
    }
  }

  /** A tool call from Novadeck's MCP server, to the operation it names. */
  private call(call: Call): Promise<unknown> {
    switch (call.type) {
      case "present":
        return this.present(call)
      case "showing":
        return Promise.resolve(this.showing(call))
      case "dismiss":
        return this.dismiss(call)
      case "open":
        return this.open(call)
      case "close":
        return this.closePeer(call)
      case "ask":
      case "tell": {
        const record = this.records.get(call.terminalId)
        if (!record || record.exitQueued || !sameToken(record.token, call.token))
          return Promise.resolve(unansweredCalls[call.type])
        return Promise.resolve(this.asks.call(call.terminalId, call.type, call.request))
      }
      case "send":
        return this.send(call)
      case "agents":
        return this.agents(call)
      case "summarize":
        return this.summarize(call)
    }
  }

  /**
   * Summarizes the caller's own terminal, as its agent asked through Novadeck's MCP
   * server: the summary of its work `agents()` lists. It names nothing: titles are the
   * person's, murmur's and the opener's, so an agent has no way to set one. The call
   * tells murmur to look at the terminal again, now that its agent said what it works on.
   * A call without the shell's own token learns nothing more.
   */
  async summarize(call: Call): Promise<SummarizeAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.summarize
    const read = readSummarizeRequest(call.request)
    if (!read.ok) return read
    const summary = cleanSummary(read.request.summary)
    const refusal = summaryRefusal(summary)
    if (refusal) return refused(refusal)
    // Drift is measured from where its work is now.
    const facts = await this.peers.facts(record)
    if (this.stopping || this.records.get(call.terminalId) !== record)
      return unansweredCalls.summarize
    record.naming = summarized(record.naming, summary)
    record.nudges = afterSummary(record.nudges, facts)
    this.save(record, false)
    this.murmur?.summarized(record.summary.id)
    return { ok: true }
  }

  /**
   * A client shows the terminal's turn end at `at` unread: murmur is asked for the gist of
   * its reply. Nothing happens without murmur, for an unknown terminal, or an end that is
   * no longer the last.
   */
  gistWanted(terminalId: string, at: number): void {
    this.murmur?.replied(terminalId, at)
  }

  /** Sends another terminal's agent a message, as an agent asked through Novadeck's MCP server. */
  send(call: Call): Promise<SendAnswer> {
    return this.peers.send(call)
  }

  /** The other terminals in the caller's project and session, described, as an agent asked. */
  agents(call: Call): Promise<AgentsAnswer> {
    return this.peers.agents(call)
  }

  /** A hook printed what a lease delivered. */
  private acknowledge(ack: Ack): void {
    this.peers.acknowledge(ack)
  }

  inboxLetters(): InboxLetter[] {
    return this.asks.list()
  }
  watchAsks(signal?: AbortSignal): AsyncGenerator<InboxLetter[]> {
    return this.asks.watch(signal)
  }
  answerAsk(id: string, answer: AskAnswer): void {
    this.asks.answer(id, answer)
  }
  readTells(ids: readonly string[]): void {
    this.asks.read(ids)
  }

  /** A terminal's threads and messages with their states. */
  messages(terminalId: string): TerminalMessages {
    return this.asks.history(terminalId, this.peers.messages(terminalId))
  }

  /**
   * A terminal's threads and messages, as `messages` lists them, then again on each change
   * to them, to its delivery state or to the pause, until the terminal is gone or `signal`
   * aborts.
   */
  async *watchMessages(terminalId: string, signal?: AbortSignal): AsyncGenerator<TerminalMessages> {
    if (this.stopping) throw new DomainError("CLOSING")
    // Only for a terminal the runner holds: closing or evicting it ends the stream.
    this.record(terminalId)
    yield* this.snapshots(this.mail, terminalId, this.messages(terminalId), signal)
  }

  /** Tells the terminal's message watchers what its listing says now. */
  private mailChanged(terminalId: string): void {
    const readers = this.mail.get(terminalId)
    if (!readers?.size || this.stopping || !this.records.has(terminalId)) return
    const listing = this.messages(terminalId)
    const key = JSON.stringify(listing)
    for (const reader of readers) reader.push(listing, key)
  }

  /** Pauses messaging across the whole runner, or resumes it. */
  pauseMessages(paused: boolean): void {
    this.peers.pause(paused)
  }

  /** Releases a thread held for going back and forth too often. */
  releaseThread(thread: string): void {
    this.peers.release(thread)
  }

  /** Stops a thread: its messages not yet delivered are gone, and nothing continues it. */
  stopThread(thread: string): void {
    this.peers.stop(thread)
  }

  /** The project a session belongs to, or the session itself when that cannot be told. */
  private projectOf(sessionId: string): string {
    try {
      return this.options.projectOf?.(sessionId) ?? sessionId
    } catch {
      return sessionId
    }
  }

  /** Whether a terminal created now could start a command; see `spawn`. */
  private async startsCommands(): Promise<boolean> {
    const integration = await this.integration
    return (
      integration !== undefined &&
      this.options.shellArgs === undefined &&
      startsCommands(this.options.shell)
    )
  }

  /**
   * Agents' requests for a new terminal, for the client to open where it lays terminals
   * out: each request goes to the newest of these streams, until `signal` aborts, the
   * owner is released, or the runner shuts down.
   */
  requests(ownerId: string, signal?: AbortSignal): AsyncGenerator<TerminalRequest> {
    if (this.stopping) throw new DomainError("CLOSING")
    return this.opens.follow(ownerId, signal)
  }

  /** The client's answer to a request; NOT_FOUND once nothing waits for it. */
  answerRequest(answer: TerminalRequestAnswer, ownerId: string): void {
    this.opens.answer(answer, ownerId)
  }

  /** The folder of the session's project; undefined when that cannot be told. */
  private projectFolder(sessionId: string): string | undefined {
    try {
      return this.options.projectFolder?.(sessionId)
    } catch {
      return undefined
    }
  }

  /**
   * A terminal's snapshots, from `first`, as they are pushed to `streams`' readers,
   * until they are finished or `signal` aborts.
   */
  private async *snapshots<T>(
    streams: Map<string, Set<Latest<T>>>,
    terminalId: string,
    first: T,
    signal: AbortSignal | undefined,
  ): AsyncGenerator<T> {
    const reader = new Latest<T>()
    reader.push(first)
    const readers = streams.get(terminalId) ?? new Set()
    streams.set(terminalId, readers.add(reader))
    const abort = () => reader.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Snapshots are delivered in order.
        const next = await reader.next()
        if (next === undefined) return
        yield next
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.finish()
      readers.delete(reader)
      if (readers.size === 0 && streams.get(terminalId) === readers) streams.delete(terminalId)
    }
  }

  /**
   * An actor's conversation, as its harness recorded it: every item so far, then each
   * later one, until the terminal's agent leaves the session it belongs to or `signal`
   * aborts. An actor the bound session does not have, or whose harness keeps no
   * transcript Novadeck reads, is NOT_FOUND.
   */
  async *transcript(
    terminalId: string,
    actor: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TranscriptChange> {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(terminalId)
    const { binding, transcript: root } = record
    const source = binding && harnesses[binding.agent].transcripts
    const native = binding && actorOf(binding, record.activity, actor)
    if (!binding || !source || !root || native === undefined) throw new DomainError("NOT_FOUND")
    const path = await source.locate(root, binding.sessionId, native)
    if (!path || record.binding !== binding) throw new DomainError("NOT_FOUND")
    const reader = new AbortController()
    record.sourceReaders.add(reader)
    const abort = () => reader.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.abort()
    try {
      yield* transcriptChanges(path, source.items, reader.signal)
    } finally {
      signal?.removeEventListener("abort", abort)
      reader.abort()
      record.sourceReaders.delete(reader)
    }
  }

  ack(input: { terminalId: string; sequence: number }, ownerId: string): void {
    // A closed terminal's viewers still acknowledge the events they drain.
    const record = this.draining.get(input.terminalId) ?? this.record(input.terminalId)
    // A final ACK can arrive after natural stream completion or cancellation.
    record.terminal.ack(ownerId, input.sequence)
  }

  release(ownerId: string): void {
    for (const pending of this.pendingOwners.get(ownerId) ?? []) pending.released = true
    for (const record of [...this.records.values(), ...this.draining.values()]) {
      record.terminal.release(ownerId)
      this.settle(record)
    }
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
    this.opens.release(ownerId)
    this.options.items?.release(ownerId)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // The last save happens while every shell still runs; ending them saves nothing, so
    // what they print on the way out cannot replace it.
    this.persist()
    this.stopping = true
    clearInterval(this.sampler)
    this.sampler = undefined
    clearInterval(this.saver)
    this.saver = undefined
    for (const watcher of this.watchers.keys()) watcher.finish()
    this.opens.finish()
    this.options.items?.shutdown()
    for (const streams of [this.details, this.mail])
      for (const readers of streams.values()) for (const reader of readers) reader.finish()
    for (const record of this.records.values()) this.unwatch(record)
    this.doorbell?.close()
    this.asks.close()
    this.messaging.close()
    this.shutdownPromise = this.stop()
    return this.shutdownPromise
  }

  private async stop(): Promise<void> {
    this.murmur?.stop()
    this.shutdownBy = Date.now() + shutdownTreesMs
    await Promise.all([...this.records.values()].map((record) => this.terminate(record)))
    for (const record of [...this.records.values(), ...this.draining.values()]) {
      record.terminal.end()
      this.dispose(record)
    }
    this.records.clear()
    this.draining.clear()
    this.pendingOwners.clear()
    this.stopped = true
    await (await this.integration)?.reports.close()
  }

  private record(id: string): Record {
    const record = this.records.get(id)
    if (!record) throw new DomainError("TERMINAL_NOT_FOUND")
    return record
  }

  private available(id: string): void {
    // A closed terminal's id stays taken while its record drains to attached viewers.
    if (this.records.has(id) || this.draining.has(id)) {
      throw new DomainError("CONFLICT", "Terminal id is already taken.")
    }
  }

  /** Reports the record's current summary to every watcher. */
  private announce(record: Record): void {
    // A closed terminal's watchers already heard it is gone; its exit must not add it back.
    if (!record.closed)
      for (const watcher of this.watchers.keys()) watcher.changed({ ...record.summary })
    this.detailed(record)
  }

  private detailOf(record: Record): AgentDetail {
    return agentDetail(
      record.summary.id,
      record.binding,
      record.activity,
      record.telemetry,
      this.dialogs.view(record.summary.id),
      this.dialogs.answered(record.summary.id),
    )
  }

  /** Tells the terminal's detail readers of a change; each drops one it already has. */
  private detailed(record: Record): void {
    const readers = this.details.get(record.summary.id)
    if (!readers) return
    const detail = this.detailOf(record)
    for (const reader of readers) reader.push(detail)
  }

  /** Ends the terminal's detail and messages streams, as it is closed. */
  private undetail(id: string): void {
    for (const streams of [this.details, this.mail]) {
      for (const reader of streams.get(id) ?? []) reader.finish()
      streams.delete(id)
    }
  }

  /** Starts sampling foreground processes, which continues while some terminal runs. */
  private sampleProcesses(): void {
    if (this.sampler || this.stopping || process.platform === "win32") return
    this.sampler = setInterval(() => this.sample(), this.options.processPollMs)
    this.sampler.unref()
  }

  /** Each sample asks node-pty, and on Linux reads a small /proc file, per running terminal. */
  private sample(): void {
    let running = false
    for (const record of this.records.values()) {
      if (record.summary.exit !== null || record.exitQueued) continue
      running = true
      record.foreground = sampleForeground(record.process, record.foreground)
      const current = record.foreground.process
      if (sameProcess(current, record.summary.process)) continue
      // The program a fresh shell resumes, should this one be lost.
      const lastProgram = current?.name ?? record.summary.lastProgram
      record.summary = { ...record.summary, process: current, lastProgram }
      record.changed = true
      this.announce(record)
      this.murmur?.sampled(record.summary.id)
    }
    if (running) return
    clearInterval(this.sampler)
    this.sampler = undefined
  }

  private pending(ownerId: string): { released: boolean } {
    const pending = { released: false }
    const entries = this.pendingOwners.get(ownerId) ?? new Set<{ released: boolean }>()
    entries.add(pending)
    this.pendingOwners.set(ownerId, entries)
    return pending
  }

  private complete(ownerId: string, pending: { released: boolean }): void {
    const entries = this.pendingOwners.get(ownerId)
    entries?.delete(pending)
    if (entries?.size === 0) this.pendingOwners.delete(ownerId)
  }

  private control(id: string, ownerId: string): Record {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(id)
    if (record.terminal.controller !== ownerId) throw new DomainError("CONTROL_REQUIRED")
    return record
  }

  private running(record: Record): void {
    if (record.summary.exit !== null || record.exitQueued || record.closing)
      throw new DomainError("TERMINAL_EXITED")
  }

  private async directory(cwd: string): Promise<string> {
    try {
      if (!isAbsolute(cwd)) throw new Error("Relative directory")
      const path = await realpath(cwd)
      if (!(await stat(path)).isDirectory()) throw new Error("Not a directory")
      await access(path, constants.R_OK | (process.platform === "win32" ? 0 : constants.X_OK))
      return path
    } catch {
      throw new DomainError(
        "INVALID_DIRECTORY",
        "Terminal working directory must be an accessible absolute directory.",
      )
    }
  }

  /**
   * The environment a new shell starts from: the runner's, with PATH read anew where
   * `freshPath` asks for it, as a Windows app keeps the PATH it was started with.
   */
  private async shellEnvironment(): Promise<NodeJS.ProcessEnv> {
    if (!this.options.freshPath) return this.options.env
    return refreshPath(this.options.env, { relay: this.options.relay })
  }

  /** The shell's program, a name found on the PATH the new shell gets, as `environment`. */
  private async executable(cwd: string, environment: Promise<NodeJS.ProcessEnv>): Promise<string> {
    const shell = this.options.shell
    const named = !(isAbsolute(shell) || shell.includes("/") || shell.includes("\\"))
    const env = named ? await environment : this.options.env
    const paths = named
      ? (env[pathKey(env)] ?? "").split(delimiter).map((path) => resolvePath(cwd, path, shell))
      : [resolvePath(cwd, shell)]
    const suffixes =
      process.platform === "win32"
        ? ["", ...(this.options.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")]
        : [""]
    const candidates = paths.flatMap((path) => suffixes.map((suffix) => `${path}${suffix}`))
    const available = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          if (!(await stat(candidate)).isFile()) return undefined
          await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK)
          return candidate
        } catch {
          return undefined
        }
      }),
    )
    const executable = available.find((candidate) => candidate !== undefined)
    if (executable) return executable
    throw new DomainError("SPAWN_FAILED", "Configured shell must be an executable file.")
  }

  private enqueue<T>(record: Record, operation: () => T | Promise<T>): Promise<T> {
    // Output read from now on is drawn after this, in a draw of its own.
    record.unread = null
    const result = record.chain.then(operation)
    record.chain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  /**
   * Draws output on the terminal's screen in order, after what was queued before it: what
   * arrives while a draw waits joins one batch, drawn by the next. Each draw waits for the
   * screen's callback, a timer, about 15 ms on Windows: a TUI that redraws for every key of
   * a paste, as Codex does there, took over a second to show 100 characters drawn one
   * chunk at a time, though it had drawn them in 0.2 s. The program is paused only while a
   * lot of its output waits (`OUTPUT_WAITING_CHARS`), and goes on once all of it is drawn,
   * so a program can't outrun its screen.
   */
  private output(record: Record, child: Pty, data: string): void {
    record.pendingOutput += data.length
    if (record.pendingOutput > OUTPUT_WAITING_CHARS) child.pause()
    // The draw queued last takes this with it, while nothing was queued after it.
    if (record.unread) {
      record.unread.push({ child, data })
      return
    }
    const batch = [{ child, data }]
    record.pendingReads += 1
    let drawn = 0
    void this.enqueue(record, async () => {
      if (record.unread === batch) record.unread = null
      drawn = batch.reduce((total, one) => total + one.data.length, 0)
      // Output a previous run left queued belongs to a screen that is gone.
      const text = batch
        .filter((one) => one.child === record.process)
        .map((one) => one.data)
        .join("")
      if (text === "") return
      await new Promise<void>((resolve) => record.screen.write(text, resolve))
      this.doorbell?.changed(record.summary.id)
      this.dialogs.changed(record.summary.id)
      // Once on the screen: a save while it was drawing may have taken the screen before.
      record.changed = true
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + OUTPUT_CHARS, text.length)
        const last = text.charCodeAt(end - 1)
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        const chunk = text.slice(start, end)
        this.emit(record, { type: "output", data: chunk })
        start = end
      }
    }).finally(() => {
      record.pendingReads -= 1
      record.pendingOutput -= drawn
      // Each program of the batch that still runs, as a restart's shell may have been
      // paused in a batch the one before began.
      if (record.pendingReads === 0 && !record.exitQueued)
        for (const one of new Set(batch.map((each) => each.child)))
          if (one === record.process) one.resume()
    })
    record.unread = batch
  }

  // Each event through one place, which a test watches.
  private emit(record: Record, event: Emitted): void {
    record.terminal.emit(event)
  }

  /**
   * Spawns a shell with a fresh screen; the caller attaches it to a record. Every shell
   * knows its terminal's id; with the integration it also loads it, and gets the hook's
   * launcher and the endpoint and token its connected agents report with. A `startup`
   * command runs as the integration starts; configured shell arguments leave it out,
   * unless it is `required`, when the shell does not start without it.
   */
  private spawn(
    shell: string,
    cwd: string,
    input: Size & { id?: string; terminalId?: string },
    integration: (Integration & { shims: readonly AgentName[] }) | undefined,
    base: NodeJS.ProcessEnv,
    startup?: { readonly command: string; readonly required?: boolean },
  ): Started {
    const { cols, rows } = input
    const id = input.id ?? input.terminalId ?? ""
    const token = randomBytes(24).toString("hex")
    const launch = (withStartup: boolean): ShellLaunch =>
      integration
        ? shellLaunch(shell, integration.paths, base, {
            shims: integration.shims,
            ...(withStartup &&
              startup &&
              this.options.shellArgs === undefined && {
                startup: {
                  command: startup.command,
                  file: join(integration.paths.resume, randomUUID()),
                },
              }),
          })
        : { args: [], env: base, integrated: false, resumes: false }
    let launched = launch(true)
    // The shell reads the command from a file only it and the runner can read.
    if (launched.resumeFile)
      try {
        writeFileSync(launched.resumeFile, startup!.command, { mode: 0o600, flag: "wx" })
      } catch {
        launched = launch(false)
      }
    if (startup?.required && !launched.resumes)
      throw new DomainError("SPAWN_FAILED", "This terminal's shell can't start a command.")
    const { resumeFile } = launched
    const env: NodeJS.ProcessEnv = {
      ...launched.env,
      NOVADECK_TERMINAL_ID: id,
      ...(integration && {
        NOVADECK_REPORT: integration.reports.endpoint,
        NOVADECK_REPORT_TOKEN: token,
      }),
    }
    const screen = createScreen({ cols, rows, scrollback: 1000 })
    const mouseEncoding = trackMouse(screen)
    try {
      const child = spawnPty({
        file: shell,
        args: this.options.shellArgs ?? launched.args,
        cwd,
        env,
        cols,
        rows,
        ...this.pty,
      })
      return {
        process: child,
        screen,
        mouseEncoding,
        startedAt: performance.now(),
        token,
        resumes: launched.resumes,
        resumeFile,
        resumeClaim: undefined,
      }
    } catch {
      screen.dispose()
      if (resumeFile) rmSync(resumeFile, { force: true })
      throw new DomainError("SPAWN_FAILED", "Could not start the configured shell.")
    }
  }

  /** Connects a record to its current shell and screen. */
  private listen(record: Record): void {
    const { process: child, screen } = record
    record.exited = new Promise<void>((resolve) => {
      record.resolveExit = resolve
    })
    record.listeners = [
      child.onData((data) => this.output(record, child, data)),
      child.onExit((exit) => this.exit(record, exit)),
      // Device-status queries are answered by the runner's screen, even with no viewer.
      screen.onData((data) => {
        if (!record.exitQueued) child.write(data)
      }),
      // A harness may tell by the title it sets that its prompt shows.
      screen.onTitleChange((title) => {
        record.title = title
        this.screenTitled(record, child, title)
      }),
      // The shell integration reports the directory at each prompt: OSC 7 from bash, zsh
      // and fish, OSC 9;9 from PowerShell and cmd. A directory on another machine, as
      // from a shell over SSH, is not this shell's prompt.
      screen.parser.registerOscHandler(7, (data) => {
        const cwd = osc7Directory(data)
        if (cwd !== undefined) this.prompted(record, child, cwd)
        return true
      }),
      // A full reset (ESC c, as `reset` sends) clears the screen: no marker keeps a line
      // that is no longer the one it marked. The screen still handles the reset itself.
      screen.parser.registerEscHandler({ final: "c" }, () => {
        this.forgetPrompts(record)
        return false
      }),
      screen.parser.registerOscHandler(9, (data) => {
        const cwd = osc9Directory(data)
        if (cwd === undefined) return false
        this.prompted(record, child, cwd)
        return true
      }),
    ]
  }

  /**
   * The shell showed its prompt in `cwd`: its agent is no longer in the foreground. A
   * shell resuming an agent reports its first prompt once the agent exits, so a resume
   * command still waiting by now was never taken.
   */
  private prompted(record: Record, child: Pty, cwd: string): void {
    if (record.process !== child) return
    record.promptedAt = Date.now()
    // Whether a non-empty line was entered since the last prompt: a command may have run.
    const entered = record.lineEntered
    record.lineEntered = false
    record.line = emptyLine
    record.submitted = false
    this.markPrompt(record, entered)
    record.readyEntered = false
    // Whether the startup command (an agent opened or resumed there) ran, so this prompt
    // is the first after it ended.
    const ran = record.startupRuns && !this.cancelResume(record)
    record.startupRuns = false
    record.changed = true
    const moved = cwd !== record.summary.cwd
    const { binding } = record
    // The agent it was started to run left without ever binding a session (a failed
    // login, Ctrl-C at startup, a declined trust): the lead it had ends with it. One bound
    // ends the lead only once its process is gone; suspended with Ctrl+Z it still runs,
    // and comes back with `fg`. A process Novadeck can't name can't be told suspended.
    if (binding === null) {
      // Or the agent a Ctrl+Z left suspended, found gone with no session bound since.
      if (ran || (record.suspended !== null && !alive(record.suspended))) this.endLead(record)
    } else if (binding.instance && alive(binding.instance)) {
      record.suspended = binding.instance
    } else this.endLead(record)
    // Nothing came of the agent the shell was opened to run: it is a plain shell now.
    if (binding === null && ran) record.expecting = null
    this.endBinding(record)
    // An agent whose prompt showed, with no session bound, left with it.
    this.messaging.unshown(record.summary.id)
    this.publishAgent(record, false)
    if (moved) {
      record.summary = { ...record.summary, cwd }
      this.announce(record)
      this.save(record, false)
    }
    // Every return to the prompt names the shell again (murmur skips one that shows what it
    // last described), but not one an agent just left: that is its agent's, till the next.
    if (binding === null || moved) this.murmur?.prompted(record.summary.id, entered || moved)
  }

  /**
   * Runs a terminal's report or ask once its earlier ones are done, in the order they
   * came, as a report may wait for the platform to tell who holds the foreground; other
   * terminals' never hold it up. A failure gives `fallback`.
   */
  private queue<T>(terminalId: string, work: () => Promise<T>, fallback: T): Promise<T> {
    const result = (this.reports.get(terminalId) ?? Promise.resolve())
      .then(work)
      .catch((error: unknown) => {
        console.error("Novadeck could not take an agent report:", error)
        return fallback
      })
    const tail = result.then(() => {})
    this.reports.set(terminalId, tail)
    void tail.then(() => {
      if (this.reports.get(terminalId) === tail) this.reports.delete(terminalId)
    })
    return result
  }

  private queueReport(report: Report): void {
    void this.queue(report.terminalId, () => this.report(report), undefined)
  }

  /** A Stop or prompt-time hook's ask: its report, then what it prints (see `Messaging.ask`). */
  private queueAsk(report: Report, deadline: number): Promise<HookAnswer> {
    const silent = {
      leaseId: null,
      stdout: silentFor(harnesses[report.agent].messaging, report.event),
    }
    return this.queue(report.terminalId, () => this.report(report, deadline), silent)
  }

  /**
   * A harness hook reported; its harness decodes it, and `observe` decides whether each
   * session it names is this terminal's own and the latest, and what it changes. A report
   * that names no session needs neither the foreground nor the harness's connection. An
   * ask, with its hook's `deadline`, then hears what its hook prints.
   */
  private async report(report: Report, deadline?: number): Promise<HookAnswer> {
    const silent = {
      leaseId: null,
      stdout: silentFor(harnesses[report.agent].messaging, report.event),
    }
    const record = this.records.get(report.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, report.token)) return silent
    const decoded = firedFacts(harnesses[report.agent].decode(report), report)
    // A turn's end its hook named no reply for reads the reply from the agent's
    // transcript; any other report goes on at once.
    const events =
      unreplied(decoded) < 0
        ? decoded
        : await withReplies(
            decoded,
            harnesses[report.agent].transcripts?.items,
            record.binding?.agent === report.agent
              ? { sessionId: record.binding.sessionId, transcript: record.transcript }
              : undefined,
          )
    // Its prompt shows before any session of its binds, as Antigravity's status line says.
    const promptShown = harnesses[report.agent].shown?.(report)
    const shown = promptShown && firedFacts([promptShown], report)[0]
    if (events.length === 0 && !shown) return silent
    const { process: child } = record
    const disconnections = this.disconnections.get(report.agent)
    const observes =
      shown !== undefined || events.some((event) => event.type === "session-observed")
    const [foreground, connected, reused] = observes
      ? await Promise.all([
          shellInForeground(child.pid),
          this.connected(report.agent),
          this.reusedBinding(record, events, deadline),
        ])
      : [undefined, true, undefined]
    if (record.process !== child || record.exitQueued) return silent
    // A disconnection while this waited forgot what the report would bring back.
    if (this.disconnections.get(report.agent) !== disconnections) return silent
    // The bound agent process may have exited without the shell showing a prompt, as in
    // tmux or a nested shell: its binding ended with it, and a later process may bind.
    let changed = false
    if (reused !== undefined && record.binding === reused) {
      record.left = reused
      this.endLead(record)
      this.endBinding(record)
    } else this.endExited(record)
    const facts = {
      promptedAt: record.promptedAt,
      shellInForeground: foreground,
      submitted: record.submitted,
      connected,
      busy:
        record.activity !== null &&
        (record.activity.state === "working" || record.activity.background !== null),
      platform: process.platform,
    }
    // Its prompt shows, as the agent holding the terminal tells, as for a session it names;
    // one whose hooks its harness says don't run there can take no message.
    if (shown && foreground !== true && (process.platform !== "win32" || record.submitted)) {
      const trust = await this.promptTrust(record, report.agent)
      if (record.process === child && shown.startedAt > (record.promptedAt ?? 0)) {
        if (trust === "counts") this.showPrompt(record, shown)
        else if (trust === "untrusted") this.messaging.untrusted(record.summary.id, report.agent)
      }
    }
    if (events.length === 0) return silent
    const cwd = record.summary.cwd
    // Every fact applies before messaging sees the report: a turn's start clears the
    // requests waiting on the person, and `askedCleared` must reach messaging before that
    // turn's prompt does, so a draft typed while asked counts before the person's Enter
    // could take the prompt as theirs (pinned by the integration test "applies a draft
    // typed while asked before the prompt that clears the request").
    for (const event of events) {
      if (event.type !== "session-observed") {
        this.applyFact(record, event)
        continue
      }
      if (this.late(record, event)) continue
      // The bound session's transcript, from a later report when the one that bound it
      // named none, as Antigravity's status line does.
      const { binding: bound } = record
      if (
        event.transcript !== undefined &&
        record.transcript === null &&
        bound?.agent === event.agent &&
        bound.sessionId === event.sessionId
      )
        record.transcript = event.transcript
      const next = observe(
        { sessions: record.agents, binding: record.binding, cwd: record.summary.cwd },
        event,
        facts,
      )
      if (!next) continue
      const before = record.binding
      record.agents = next.sessions
      record.binding = next.binding
      if (next.binding !== null) {
        // After a suspended agent, a binding is that agent back from `fg`, or another the
        // person started at the prompt, which its lead never directed.
        if (record.suspended !== null && next.binding.instance !== record.suspended)
          this.endLead(record)
        record.suspended = null
      }
      changed = true
      // A newly bound session waits for its first prompt; one still bound keeps its activity.
      // What its hooks told from before it bound is past, but for one fired with the hook
      // that bound it (see `boundTogetherMs`).
      const same =
        before !== null &&
        next.binding !== null &&
        before.agent === next.binding.agent &&
        before.sessionId === next.binding.sessionId
      if (!same) {
        record.activity = next.binding
          ? fresh(
              boundSince(event),
              harnesses[next.binding.agent].wakes,
              harnesses[next.binding.agent].records,
            )
          : null
        record.telemetry = null
        this.follow(record, event)
        // The plans its bar mirrored of another session go; unbinding alone keeps them.
        if (next.binding)
          this.options.items?.sessionBound(record.summary.id, next.binding.sessionId)
      }
      record.summary = { ...record.summary, cwd: next.cwd }
    }
    // A Stop Novadeck may continue shows once its ask is answered, so a continued turn
    // never flashes idle.
    const stopAsk =
      deadline !== undefined && harnesses[report.agent].messaging.asks[report.event] === "stop"
    const moved = record.summary.cwd !== cwd
    if (!stopAsk) this.publishAgent(record, moved)
    const changes = this.followRootOf(record, events, report.event === "StatusLine")
    const told = await this.attributed(record, events)
    // What the root worked on, from its prompts as told, as Antigravity's from its
    // transcript; this terminal's later reports wait for this one.
    if (this.tallyWork(record, told, changes) || changed) this.save(record, false)
    // The harness compacted the root session's context: it may have lost the notice of its bar.
    if (
      events.some(
        (event) =>
          event.type === "session-observed" && event.compacted && rootedIn(record.root, event),
      )
    )
      record.nudges = fired(record.nudges, "compaction")
    this.murmur?.reported(report.terminalId, this.reported(record, changes))
    if (deadline === undefined) {
      this.messaging.observe(report.terminalId, told)
      this.escaped(record)
      this.judgeFirst(record)
      return silent
    }
    const answer = this.messaging.ask(report.terminalId, {
      agent: report.agent,
      event: report.event,
      events: told,
      deadline,
    })
    if (stopAsk) {
      this.continued(record, told, answer)
      this.publishAgent(record, moved)
    }
    this.escaped(record)
    this.judgeFirst(record)
    return this.nudged(record, report, told, answer, deadline)
  }

  /**
   * What a report tells murmur of the terminal's root session (see `Murmur.reported`). A
   * session is new to murmur when the work's session is not the one murmur was last told
   * of, however it came to move (this report's, or another's tallied meanwhile): a root
   * bound again to the session it already worked in (a restored terminal, `claude
   * --resume`) is not, and neither is a guess corrected to its real id.
   */
  private reported(record: Record, changes: readonly RootChange[]): Reported {
    const corrected = changes.flatMap((change) =>
      change.type === "corrected"
        ? [
            {
              from: `${change.root.agent}:${change.from}`,
              to: `${change.root.agent}:${change.root.sessionId}`,
            },
          ]
        : [],
    )
    for (const { from, to } of corrected)
      if (record.murmurSession === from) record.murmurSession = to
    const session = record.work !== null && record.work.session !== record.murmurSession
    record.murmurSession = record.work?.session ?? record.murmurSession
    return { session, corrected }
  }

  /** A Stop Novadeck continued, lapsed as delivery took it, ends the agent's turn too. */
  private lapsed(record: Record): void {
    const { binding, activity } = record
    const event =
      binding && activity && this.messaging.lapsed(record.summary.id, binding, activity.turnAt)
    if (event && this.applyFact(record, event)) this.publishAgent(record, false)
  }

  /**
   * A root Stop Novadeck continued with messages, its hook's answer leasing them: the
   * agent's turn goes on, as delivery's does, until the continuation's own Stop.
   */
  private continued(record: Record, events: readonly HarnessEvent[], answer: HookAnswer): void {
    if (answer.leaseId === null) return
    const stop = events.find(
      (event) =>
        event.type === "turn-ended" &&
        event.outcome === "completed" &&
        rootedIn(record.root, event),
    )
    if (!stop || stop.type !== "turn-ended") return
    const { agent, sessionId, instance, startedAt } = stop
    this.applyFact(record, { type: "turn-continued", agent, sessionId, instance, startedAt })
  }

  /**
   * Tells whose the root session's first prompt is, once delivery has taken its turn:
   * the person's own submission, or not, as an agent's command-line prompt.
   */
  private judgeFirst(record: Record): void {
    const { work } = record
    if (!work?.first || work.firstByPerson !== undefined) return
    const prompt = this.messaging.personPrompt(record.summary.id)
    // The opener's own command-line prompt is never the person's, whatever Enter came before.
    const command =
      work.opened === true &&
      prompt !== undefined &&
      record.openerCommand !== null &&
      promptIn(record.openerCommand, prompt)
    record.work = judgedFirst(work, prompt !== undefined && !command)
    this.save(record, false)
  }

  /**
   * A prompt-time hook's answer, with Novadeck's notices when any is due (see
   * `nudges.ts`): the bar beside the terminal, for a session that begins or lost its
   * context, which a `summarize` never clears, and a nudge to summarize the terminal's
   * work, when a trigger fired since the last `summarize`; only at the person's prompt, as
   * a paragraph each, never in an answer that carries messages or another notice, nor at
   * Stop. Each of the person's prompts counts toward the backstop, and where nothing else
   * is said, whether the work drifted is looked at.
   */
  private async nudged(
    record: Record,
    report: Report,
    events: readonly HarnessEvent[],
    answer: HookAnswer,
    deadline: number,
  ): Promise<HookAnswer> {
    const { messaging } = harnesses[report.agent]
    if (messaging.asks[report.event] !== "prompt") return answer
    const prompt = events.some(
      (event) =>
        event.type === "turn-started" && event.cause === "prompt" && rootedIn(record.root, event),
    )
    if (!prompt) return answer
    const silent = answer.leaseId === null && answer.stdout === silentFor(messaging, report.event)
    const inTime = (ms: number) => deadline - Date.now() >= ms
    // Read only for an answer that has nothing else to say, so a delivery never waits on
    // it, and only with time to spare.
    const facts =
      silent && record.nudges.baseline && inTime(driftReadMs)
        ? await this.peers.facts(record)
        : undefined
    // A nudge that may miss the hook's deadline is never spent: its trigger waits.
    const taken = atPrompt(record.nudges, { quiet: silent && inTime(leaseMargin), facts })
    record.nudges = taken.nudges
    if (!taken.nudge) return answer
    return {
      leaseId: null,
      stdout: messaging.prompt(noticesAt(taken, { summary: record.naming.summary })),
    }
  }

  /**
   * Follows the terminal's root session after its binding changed or a report's facts,
   * as its harness's profile says, telling messaging how it changed, and tallies what the
   * root worked on; true when that work changed, to be saved.
   */
  private trackRoot(record: Record, events: readonly HarnessEvent[], statusLine: boolean): boolean {
    const changes = this.followRootOf(record, events, statusLine)
    const tallied = this.tallyWork(record, events, changes)
    this.murmur?.reported(record.summary.id, this.reported(record, changes))
    return tallied
  }

  /**
   * Follows the terminal's root session after its binding changed or a report's facts, as
   * its harness's profile says, telling messaging how it changed; how it changed.
   */
  private followRootOf(
    record: Record,
    events: readonly HarnessEvent[],
    statusLine: boolean,
  ): readonly RootChange[] {
    const { id } = record.summary
    const agent = record.binding?.agent ?? record.root?.agent
    const { root, changes } = followRoot(record.root, record.binding, events, {
      mode: agent ? harnesses[agent].messaging.root : "binding",
      statusLine,
      awaited: (sessionId) => this.messaging.awaits(id, sessionId),
    })
    record.root = root
    if (changes.length > 0) {
      this.messaging.rooted(id, changes)
      this.asks.rooted(id, changes)
      this.settleBox(record)
    }
    // A new root session has yet to hear of the bar beside its terminal.
    if (changes.some((change) => change.type === "new"))
      record.nudges = fired(record.nudges, "session")
    return changes
  }

  /**
   * Tallies what the root worked on from a report's facts, after its root `changes`;
   * true when that work changed, to be saved. The first session after an agent opened the
   * terminal is marked, as its first prompt may be that agent's command.
   */
  private tallyWork(
    record: Record,
    events: readonly HarnessEvent[],
    changes: readonly RootChange[],
  ): boolean {
    const after = workAfter(record.work, record.root, events, Date.now(), changes)
    if (after === record.work) return false
    const started = after !== null && after.session !== record.work?.session
    const work = started && record.awaitsOpened ? { ...after, opened: true as const } : after
    if (started) record.awaitsOpened = false
    record.work = work
    return true
  }

  /**
   * The terminal's title after what names it changed (see `titleOf`), announced when it
   * differs, as the answer says; the caller saves it.
   */
  private retitle(record: Record): boolean {
    const titled = this.titled(record.naming, record.summary)
    const { title, titleSource } = record.summary
    if (
      titled.title === title &&
      JSON.stringify(titled.titleSource) === JSON.stringify(titleSource)
    )
      return false
    record.summary = { ...record.summary, ...titled }
    this.announce(record)
    return true
  }

  /** A terminal's title, and who it is from, as its summary shows them (see `titleOf`). */
  private titled(
    naming: Naming,
    terminal: Pick<ListedTerminal, "command">,
  ): Pick<TerminalSummary, "title" | "titleSource"> {
    const { title, source } = titleOf(naming, terminal)
    return { title, titleSource: source }
  }

  /**
   * The facts with a root turn's prompt told from the agent's transcript, where its
   * harness's hooks name none (see `typedPromptStart`), remembering what was seen there.
   */
  private async attributed(
    record: Record,
    events: readonly HarnessEvent[],
  ): Promise<readonly HarnessEvent[]> {
    const { id } = record.summary
    const { root, transcript } = record
    const typedEntry = root && harnesses[root.agent].messaging.typedEntry
    if (!root || !typedEntry || !transcript) return events
    // The person's Enter, judged by when the turn's hook fired, as delivery judges it.
    const started = events.find((event) => event.type === "turn-started")
    const told = await typedPromptStart(
      events,
      {
        root,
        typedEntry,
        transcript,
        // What was seen of this transcript, not another's.
        seen: record.seenEntry?.transcript === transcript ? record.seenEntry.id : undefined,
        enteredAt:
          started && this.messaging.pendingSubmission(id, started.startedAt, started.firedAt),
        ringing: this.messaging.ringing(id),
        startedWith: record.startedWith,
      },
      undefined,
      { waitMs: transcriptWaitMs(this.options.platform) },
    )
    if (told.seen !== undefined) record.seenEntry = { transcript, id: told.seen }
    return told.events
  }

  /** Follows the root after the terminal's binding changed outside its hooks' reports. */
  private rebound(record: Record): void {
    this.trackRoot(record, [], false)
  }

  /**
   * The terminal's title changed: a harness that tells by its title that its prompt shows,
   * as Codex through Novadeck's shim, may say so. Anything can set a title, so it counts
   * only while a process of that harness's name runs in the terminal's foreground, in turn
   * with the terminal's reports.
   */
  private screenTitled(record: Record, child: Pty, title: string): void {
    // Any newer title, including Working or a shell's, retires a pending prompt check.
    const seq = (record.titles = (record.titles ?? 0) + 1)
    if (record.readyEntered && agents.some((agent) => harnesses[agent].titleWorking?.(title)))
      record.readyTurned = true
    for (const agent of agents) {
      const shown = harnesses[agent].title?.(title, Date.now())
      if (!shown) continue
      const { binding } = record
      const prefix = shown.sessionPrefix
      // Its bound session at its prompt again, as after each turn: nothing to ask.
      if (binding?.agent === agent && prefix !== undefined && binding.sessionId.startsWith(prefix))
        continue
      // As for a report: Windows tells no foreground, so only once a line was entered.
      if (process.platform === "win32" && !record.submitted) continue
      // As it came: the session it may replace, and whether a turn ran, as a spawned
      // agent's thread is made only within one.
      const replaced = binding?.agent === agent ? binding.sessionId : undefined
      const delivery = this.messaging.delivery(record.summary.id)
      const turning = delivery?.state === "working"
      // A session bound, a binding ended or a root turn started since makes it stale.
      const epoch = delivery?.epoch
      // Asked before it joins the terminal's queue, so a slow answer from the harness
      // never holds the terminal's reports up.
      // Still the terminal's latest title, from the same process, with no session bound, no
      // binding ended and no root turn started since, nor the shell's prompt back. Only the
      // binding it found, ended since as its process was found gone (by a ring's check or a
      // report while this asked), and nothing after: its prompt shows as from no binding.
      const current = () => {
        if (record.titles !== seq || record.process !== child || record.exitQueued) return false
        const now = this.messaging.delivery(record.summary.id)?.epoch
        if (now === epoch) return true
        return (
          binding !== null &&
          epoch !== undefined &&
          now === epoch + 1 &&
          record.left === binding &&
          record.binding === null
        )
      }
      void (async () => {
        // A transient helper failure must not consume the only Ready observation. Ask at
        // most three times, checking the foreground and staleness anew; Unknown never
        // grants readiness or claims that the hooks are untrusted.
        let found: Awaited<ReturnType<Terminals["harnessIn"]>> = null
        let trust: Awaited<ReturnType<Terminals["promptTrust"]>> = "unknown"
        let pid: number | undefined
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (attempt > 0)
            // eslint-disable-next-line no-await-in-loop -- Bounded recovery of this one prompt observation.
            await sleep(trustRecheckMs, undefined, { ref: false })
          if (!current()) return
          // eslint-disable-next-line no-await-in-loop -- Each retry checks the current foreground.
          found = await this.harnessIn(record, child, agent)
          if (!found || !current()) return
          if (attempt === 0) pid = found.pid
          else if (found.pid !== pid) return
          // eslint-disable-next-line no-await-in-loop -- Unknown is retried only within this bounded observation.
          trust = await this.promptTrust(record, agent, found.where)
          if (!current()) return
          if (trust !== "unknown") break
        }
        if (!found) return
        // The helper (or a preceding queued report) may have waited while the harness
        // exited into a chained command, without any new title, key or shell prompt.
        // Check at the commit too, keeping the same harness process where the OS tells.
        const inForeground = async () => {
          if (!current()) return false
          const now = await foregroundProcess(child.pid, agent)
          return current() && now !== null && now?.pid === pid
        }
        // Hooks its harness says don't run there: no message can reach it, as long as this
        // title still stands. A late answer marks no terminal the agent has left.
        if (trust === "untrusted" && !binding)
          return this.queue(
            record.summary.id,
            async () => {
              if ((await inForeground()) && shown.startedAt > (record.promptedAt ?? 0))
                this.messaging.untrusted(record.summary.id, agent)
            },
            undefined,
          )
        if (trust !== "counts") return
        // The bound agent left unseen, as its own process is gone: this prompt is another's.
        const exited = binding?.instance ? !alive(binding.instance) : false
        // Another session's id ends the bound one only once the harness says it started
        // it as a new root; otherwise that session's own hooks tell, at its first prompt.
        if (binding && !exited) {
          if (replaced === undefined || prefix === undefined || turning) return
          const started = await harnesses[agent].startedSession?.(
            found.where,
            prefix,
            shown.startedAt,
            (path) => this.held(found.group, path),
          )
          if (started !== true) return
        }
        await this.queue(
          record.summary.id,
          async () => {
            if (!(await inForeground())) return
            // Ended in turn with the reports, so a session bound since is never touched.
            if (exited && record.binding === binding) this.endExited(record)
            this.showPrompt(record, shown, exited ? undefined : replaced)
          },
          undefined,
        )
      })().catch((error: unknown) => console.error("Novadeck could not read a title:", error))
    }
  }

  /**
   * Where the harness runs in the terminal, as its hooks would be asked about there: its
   * own program and the variables its adapter names, where the platform tells them
   * (Linux), else the person's login's, else the shells'; and the processes of the
   * foreground group it runs in (`group`). Null when none of its name holds the
   * foreground, so nothing of it shows there.
   */
  private async harnessIn(
    record: Record,
    child: Pty,
    agent: AgentName,
  ): Promise<{
    readonly where: Install & { readonly program?: string }
    readonly group: readonly number[]
    readonly pid: number | undefined
  } | null> {
    const found = await foregroundProcess(child.pid, agent)
    if (found === null || record.process !== child) return null
    const install = await this.options.install(agent)
    const own = found ? processSetting(found.pid, harnesses[agent].environment ?? []) : undefined
    const env = { ...this.options.env, ...install?.env, ...own?.env }
    // Its own program, unless what holds that name is a script, as a wrapper may be.
    const program = own?.program && basename(own.program) === agent ? own.program : undefined
    return {
      where: {
        env,
        home: env.HOME ?? install?.home ?? homedir(),
        platform: process.platform,
        plugin: install?.plugin ?? "",
        ...(program !== undefined && { program }),
      },
      group: found?.group ?? [],
      pid: found?.pid,
    }
  }

  /**
   * Whether one of the processes holds the file open; undefined where the platform
   * doesn't tell, or none of them could be read.
   */
  private async held(pids: readonly number[], path: string): Promise<boolean | undefined> {
    const real = await realpath(path).catch(() => path)
    let told = false
    for (const pid of pids) {
      // eslint-disable-next-line no-await-in-loop -- A foreground group holds few processes.
      const files = await openFiles(pid)
      if (!files) continue
      told = true
      if (files.includes(real)) return true
    }
    return told ? false : undefined
  }

  /**
   * Whether a prompt the harness shows counts: it is connected, and Novadeck's hooks run
   * for it there, as `where` (see `harnessIn`) asks it. `untrusted` only when the harness
   * answered that they don't run there, as nothing could deliver to that agent; `unknown`
   * when it couldn't answer, or nothing could ask it.
   */
  private async promptTrust(
    record: Record,
    agent: AgentName,
    where?: Install & { readonly program?: string },
  ): Promise<"counts" | "untrusted" | "unknown"> {
    if (!(await this.connected(agent))) return "unknown"
    const trusted = await this.hooksTrustedIn(record, agent, where).catch(() => undefined)
    return trusted === true ? "counts" : trusted === false ? "untrusted" : "unknown"
  }

  /**
   * Looks at the screen while delivery is Drafting only by doubt after a late hook: once
   * the agent's box reads empty on two reads running, nothing was left in it, and delivery
   * is Ready before its first turn or Settled after one completed. Gives up when doubt
   * ends or after `boxSettleMs`, leaving the draft; a later doubt has its own window.
   */
  private settleBox(record: Record): void {
    const id = record.summary.id
    const current = this.messaging.delivery(id)
    if (
      this.settling.has(id) ||
      current?.state !== "drafting" ||
      !current.box.doubted ||
      record.boxDoubtEpoch === current.epoch
    )
      return
    this.settling.add(id)
    void (async () => {
      let until = 0
      let epoch: number | undefined
      let seen = false
      try {
        for (;;) {
          const delivery = this.messaging.delivery(id)
          // The cases where `emptied` does nothing in the current epoch: keep the two in step,
          // or the `continue` below spins without waiting.
          if (!delivery?.box.doubted || delivery.state !== "drafting") return
          // A new doubt starts anew: its own window, its own two reads.
          if (delivery.epoch !== epoch) {
            epoch = delivery.epoch
            record.boxDoubtEpoch = epoch
            until = Date.now() + boxSettleMs
            seen = false
          }
          if (Date.now() >= until) return
          // The read counts from before it began: a key typed meanwhile is not forgotten.
          const readAt = Date.now()
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          const screen = await this.screenOf(id)
          const profile = this.live(id) && this.boxOf(record)
          if (!screen || !profile) return
          const box = profile.read(screen)
          const empty =
            box !== undefined && box.mode === "prompt" && isEmpty(box) && !profile.queued(screen)
          if (empty && seen) {
            this.messaging.emptied(id, delivery.epoch, readAt)
            // Stale if the epoch changed during the read: a later doubt is polled anew.
            continue
          }
          seen = empty
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          await sleep(100, undefined, { ref: false })
        }
      } finally {
        this.settling.delete(id)
      }
    })().catch(() => undefined)
  }

  /** Whether Novadeck's hooks run for the agent in the terminal's folder; undefined unknown. */
  private hooksTrustedIn(
    record: Record,
    agent: AgentName,
    where?: Install & { readonly program?: string },
  ): Promise<boolean | undefined> {
    const { cwd } = record.summary
    if (this.options.hooksTrusted) return this.options.hooksTrusted(agent, cwd)
    const trusted = harnesses[agent].hooksTrusted
    if (!trusted) return Promise.resolve(true)
    return where ? trusted(where, cwd) : Promise.resolve(undefined)
  }

  /**
   * A connected harness's own empty prompt shows, before a session it names in full binds,
   * and Novadeck's hooks run for it there (`promptTrust`; see docs/agent-messaging.md,
   * "States"): messages wait for the session it starts there, and the doorbell may ring
   * it. One the shell's prompt came after is stale: the agent left. With a session of
   * that agent bound, it changes nothing, unless it `replaces` it, as the harness started
   * a new root session (Codex's /clear), which binds only with its first prompt: the bound
   * one's binding ends, the state the new prompt gives staying.
   */
  private showPrompt(record: Record, shown: PromptShown, replaced?: string): void {
    const { agent, sessionPrefix } = shown
    if (shown.startedAt <= (record.promptedAt ?? 0)) return
    const { binding } = record
    const id = record.summary.id
    if (!binding) {
      this.messaging.shown(id, agent, sessionPrefix ?? null)
      record.readyEntered = false
      this.publishAgent(record, false)
      return
    }
    // Only the session it was shown to replace, still bound: one bound since, as the new
    // session's own first prompt binds it, stays.
    if (replaced === undefined || binding.sessionId !== replaced) return
    if (sessionPrefix !== undefined && binding.sessionId.startsWith(sessionPrefix)) return
    // Judged as the title came, not after what was asked since.
    this.messaging.shown(id, agent, sessionPrefix ?? null, true, shown.startedAt, shown.firedAt)
    this.endBinding(record, replaced)
    this.settleBox(record)
  }

  /**
   * A Windows pid can already name another process when the next agent reports. Only
   * a known start after the bound session was observed proves that reuse: an unknown
   * tree, a missing root or an older process leaves the nested-agent gate intact.
   */
  private async reusedBinding(
    record: Record,
    events: readonly HarnessEvent[],
    deadline?: number,
  ): Promise<Binding | undefined> {
    const { binding } = record
    if (this.options.platform !== "win32" || !binding?.instance) return undefined
    if (
      !events.some(
        (event) =>
          event.type === "session-observed" &&
          event.instance !== null &&
          (event.agent !== binding.agent ||
            event.instance !== binding.instance ||
            (event.evidence === "startup" && event.sessionId !== binding.sessionId)),
      )
    )
      return undefined
    // A late old hook can move this forward and hide reuse; it cannot prove a live
    // original process is newer than its own hook.
    const observed = record.agents[binding.agent]?.seq
    if (observed === undefined) return undefined
    // Leave an asking hook time to print its answer; a report has the relay's normal bound.
    const timeoutMs =
      deadline === undefined ? relayMs : Math.min(relayMs, deadline - Date.now() - 500)
    if (timeoutMs <= 0) return undefined
    const pid = Number(binding.instance)
    const members = await this.trees.read(pid, timeoutMs)
    const root = members?.find((member) => member.pid === pid)
    // The two wall-clock samples may round differently; close starts prove nothing.
    return root !== undefined && root.startedAt > observed + 50 ? binding : undefined
  }

  /**
   * Ends the binding of an agent process known to have exited without the shell showing
   * its prompt, as in tmux, a nested shell or `claude ; codex`: whatever shows or binds
   * there next is another agent's. Whether it ended one. Where its reports name no
   * process, nothing tells, and the binding stays until the shell's prompt.
   */
  private endExited(record: Record): boolean {
    const { binding } = record
    if (!binding?.instance || alive(binding.instance)) return false
    record.left = binding
    // The agent's process is gone: the lead it had ends with it.
    this.endLead(record)
    return this.endBinding(record)
  }

  /** Whether an observation is a late one of the session whose process was found gone. */
  private late(record: Record, event: SessionObserved): boolean {
    const { left } = record
    return (
      left !== undefined &&
      left.agent === event.agent &&
      left.sessionId === event.sessionId &&
      (event.instance === null || event.instance === left.instance)
    )
  }

  /**
   * Ends the terminal's lead, as the agent it led exited: kept, shown to watchers, and
   * told to messaging, so what the former lead sends reads as a peer's from then on.
   */
  private endLead(record: Record): void {
    if (record.summary.ledBy === null) return
    record.summary = { ...record.summary, ledBy: null }
    record.suspended = null
    this.messaging.endLead(record.summary.id)
    this.save(record, false)
    this.announce(record)
  }

  /**
   * Ends the terminal's binding, with its activity and the sources that follow it; with
   * `only`, only while that session is still the one bound. Whether it ended one.
   */
  private endBinding(record: Record, only?: string): boolean {
    if (only !== undefined && record.binding?.sessionId !== only) return false
    record.binding = null
    record.activity = null
    record.telemetry = null
    this.unwatch(record)
    this.rebound(record)
    if (record.summary.agent !== null) {
      record.summary = {
        ...record.summary,
        agent: null,
        ready: this.readyOf(record),
        activity: null,
        telemetry: null,
      }
      this.announce(record)
    }
    return true
  }

  /**
   * Follows the newly bound session's own sources, as its transcript, until its binding
   * ends; what they say applies like its hooks' reports.
   */
  private follow(record: Record, event: SessionObserved): void {
    this.unwatch(record)
    record.transcript = event.transcript ?? null
    const { binding } = record
    const watch = binding && harnesses[binding.agent].watch
    if (!binding || !watch || event.transcript === undefined) return
    const controller = new AbortController()
    record.watching = controller
    const run = {
      sessionId: binding.sessionId,
      instance: binding.instance,
      transcript: event.transcript,
    }
    void watch(run, controller.signal, (fact) => {
      if (record.watching !== controller || fact.type === "session-observed") return
      this.sourceFact(record, fact)
    }).catch((error: unknown) => console.error("Novadeck stopped following an agent:", error))
  }

  /** Applies what the bound session's own sources said, as its hooks' reports apply. */
  private sourceFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): void {
    const running = record.activity?.state === "working"
    const applied = this.applyFact(record, fact)
    if (applied) this.publishAgent(record, false)
    // What only its records say, as an interrupted turn, reaches messaging too. A turn's
    // end its records told does only where it ended the turn, never a record used up as a
    // continued Stop's, with what the activity holds the turn left running, so the two
    // tell the same.
    const ended = applied && running && record.activity?.state === "idle"
    const facts =
      fact.type !== "turn-ended" || !fact.recorded
        ? [fact]
        : ended
          ? [{ ...fact, background: record.activity?.background ?? { agents: 0, tasks: 0 } }]
          : []
    if (this.trackRoot(record, facts, false)) this.save(record, false)
    this.messaging.observe(record.summary.id, facts)
    this.escaped(record)
  }

  /**
   * The person may trust the agent's hooks in the agent itself (Codex's `/hooks`), which
   * sets no new title (probed with Codex 0.159.3): once their keys pause, the latest title
   * is read again, asking about the hooks afresh.
   */
  private recheckTrust(record: Record): void {
    if (record.recheck) clearTimeout(record.recheck)
    const child = record.process
    record.recheck = setTimeout(() => {
      record.recheck = undefined
      const { title } = record
      if (
        title === undefined ||
        record.process !== child ||
        record.exitQueued ||
        !this.messaging.untrustedAgent(record.summary.id)
      )
        return
      this.screenTitled(record, child, title)
    }, trustRecheckMs)
    record.recheck.unref()
  }

  /**
   * The person's Escape that may have cancelled the root turn, as delivery took it, ends
   * the turn for the agent's activity too, so the two tell the same.
   */
  private escaped(record: Record): void {
    const { binding } = record
    const event = binding && this.messaging.escaped(record.summary.id, binding)
    if (!event) return
    if (this.applyFact(record, event)) this.publishAgent(record, false)
    this.awaitVerdict(record, event)
  }

  /**
   * The harness has `escapeVerdictMs` to say how the turn the Escape ended ended, as its
   * reply may have reached it first. Once that passes, a Stop it reported meanwhile is the
   * turn's end, else a reply the transcript of a harness without records holds since the
   * person's prompt, else the Escape stands.
   */
  private awaitVerdict(record: Record, { agent, sessionId, instance, startedAt }: ActivityEvent) {
    if (record.verdict) clearTimeout(record.verdict)
    const lapse = (reply: string | undefined) => {
      const { binding } = record
      if (!binding || binding.sessionId !== sessionId || this.stopping) return
      const lapsed: ActivityEvent = {
        type: "turn-escape-lapsed",
        agent,
        sessionId,
        instance,
        startedAt,
        ...(reply !== undefined && { reply }),
      }
      if (this.applyFact(record, lapsed)) this.publishAgent(record, false)
    }
    record.verdict = setTimeout(() => {
      record.verdict = undefined
      const reading = this.unstoppedReply(record, agent)
      if (reading) void reading.then(lapse)
      else lapse(undefined)
    }, escapeVerdictMs)
    record.verdict.unref()
  }

  /**
   * The read of the reply the transcript holds since the person's prompt of the turn their
   * Escape ended, where no Stop came for it and the harness keeps no records that would
   * say how it ended: undefined where there is nothing to read, and the read's undefined
   * where it holds none, can't be read, or the screen doesn't show the turn went on
   * uninterrupted, as Antigravity may say it stopped under a reply it kept. The screen is
   * what tells: an Escape between a response's words and the tool call after them leaves
   * the words recorded alone as the response, just as a reply that won is recorded, and
   * Antigravity drew its interruption under them every time (probed 2026-10-11, 1.2.14,
   * the call streamed 1.5 s after the words); a step's time is no help, as the cut-off
   * one came 56 to 94 ms after the key, where a reply that just won lands too. Only on
   * Windows, the one place a reply that won the race was seen to fire no Stop (Antigravity
   * 1.2.14): elsewhere its Stop tells.
   */
  private unstoppedReply(
    record: Record,
    agent: AgentName,
  ): Promise<string | undefined> | undefined {
    if (process.platform !== "win32") return undefined
    const escaped = record.activity?.lastTurn?.escaped
    const items = harnesses[agent].transcripts?.items
    if (harnesses[agent].records || !escaped || escaped.held || escaped.settled) return undefined
    if (!record.transcript || !items) return undefined
    const { interrupted } = harnesses[agent].box
    return lastReply(record.transcript, items)
      .then(async (reply) => {
        if (reply === undefined || !interrupted) return reply
        // The word may be drawn after the reply, so the screen is read again until the
        // window ends: the Escape stands where a read shows the word, or where the last
        // read can't tell (mid-redraw, under a dialog), and the reply won only where the
        // last shows it alone.
        const until = Date.now() + escapeScreenMs
        for (;;) {
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          const screen = await this.screenOf(record.summary.id)
          if (!screen) return undefined
          const shown = interrupted(screen)
          if (shown === true) return undefined
          if (Date.now() >= until) return shown === false ? reply : undefined
          // eslint-disable-next-line no-await-in-loop -- Each read waits for the one before.
          await sleep(250, undefined, { ref: false })
        }
      })
      .catch(() => undefined)
  }

  /** Applies what the bound session's hooks or records said; true when it changed. */
  private applyFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): boolean {
    const waited = (record.activity?.pending.length ?? 0) > 0
    const applied = this.appliedFact(record, fact)
    // A request no longer waits on the person: what they typed meanwhile counts now, at
    // once, before the report's prompt reaches messaging. The doorbell looks again too, as
    // the request kept it from ringing and its screen may not change.
    const waits = (record.activity?.pending.length ?? 0) > 0
    if (waited && !waits) {
      this.messaging.askedCleared(record.summary.id)
      this.doorbell?.changed(record.summary.id)
    }
    // A request asked while a ring is under way (none waited as it began) may show its
    // dialog where the ring's Enter would land: the ring fails, pressing nothing more, as
    // its line may already be in that dialog.
    const nonce = waits ? this.messaging.ringing(record.summary.id) : undefined
    if (nonce !== undefined) this.messaging.ringFailed(record.summary.id, nonce)
    if (applied) this.watchActors(record)
    return applied
  }

  /**
   * Follows each running subagent with a request waiting in its own sources, where its
   * harness reads them, for what ends its turn that no hook reports (Codex's rollout
   * recording Esc on its request): from its oldest request's ask, until it has none
   * waiting or the binding ends. What they say applies like its hooks' reports.
   */
  private watchActors(record: Record): void {
    const { binding, activity, transcript, actorWatches } = record
    const watchActor = binding && harnesses[binding.agent].watchActor
    const waiting = new Map<string, number>()
    if (binding && activity && transcript !== null && watchActor)
      for (const { actor, askedAt } of activity.pending)
        if (actor !== null && activity.subagents.some(({ id }) => id === actor))
          waiting.set(actor, Math.min(askedAt, waiting.get(actor) ?? Number.POSITIVE_INFINITY))
    for (const [actor, { controller, since }] of actorWatches)
      if (waiting.get(actor) !== since) {
        controller.abort()
        actorWatches.delete(actor)
      }
    if (!binding || !watchActor || transcript === null) return
    const run = { sessionId: binding.sessionId, instance: binding.instance, transcript }
    for (const [actor, since] of waiting) {
      if (actorWatches.has(actor)) continue
      const controller = new AbortController()
      actorWatches.set(actor, { controller, since })
      void watchActor(run, actor, since, controller.signal, (fact) => {
        if (actorWatches.get(actor)?.controller !== controller) return
        if (fact.type === "session-observed") return
        this.sourceFact(record, fact)
      }).catch((error: unknown) => console.error("Novadeck stopped following a subagent:", error))
    }
  }

  private appliedFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): boolean {
    if (!record.binding) return false
    if (fact.type === "telemetry-observed") {
      const next = observeTelemetry(record.telemetry, record.binding, fact)
      if (next) record.telemetry = next
      if (next) this.latchLimit(record)
      return next !== undefined
    }
    const next = record.activity && apply(record.activity, record.binding, fact)
    if (next) record.activity = next
    if (next && fact.type === "plan-observed") void this.planned(record, record.binding, fact)
    if (next && fact.type === "turn-ended") this.latchLimit(record)
    return Boolean(next)
  }

  /**
   * Latches the usage-limit window a turn that just ended, or one idle since, ran into on
   * its last turn, from the limits the session's records showed (`limitOf`).
   */
  private latchLimit(record: Record): void {
    const { activity, telemetry } = record
    if (!activity || !telemetry || activity.state !== "idle") return
    const limit = limitOf(activity.lastTurn, telemetry.limits, telemetry.at)
    const next = limit && withLimit(activity, limit)
    if (next) record.activity = next
  }

  /**
   * Mirrors a plan the bound session observed on the terminal's bar: its file, or for one
   * presented as text, the transcript or rollout recording it, which reads it back once
   * the terminal is gone. A text plan with no record to point at is not kept.
   */
  private async planned(
    record: Record,
    binding: Binding,
    fact: Extract<ActivityEvent, { type: "plan-observed" }>,
  ): Promise<void> {
    const { items } = this.options
    const place = this.place(record.summary.id)
    if (!items || !place) return
    const { plan, actor } = fact
    const transcripts = harnesses[binding.agent].transcripts
    const path =
      plan.kind === "file"
        ? plan.path
        : record.transcript && transcripts
          ? await transcripts
              .locate(record.transcript, binding.sessionId, actor)
              .catch(() => undefined)
          : undefined
    if (!path || this.stopping) return
    await items.planObserved(
      place,
      { agent: binding.agent, agentSession: binding.sessionId, actor },
      { source: plan, path },
      fact.startedAt,
    )
  }

  private unwatch(record: Record): void {
    record.watching?.abort()
    record.watching = null
    for (const { controller } of record.actorWatches.values()) controller.abort()
    record.actorWatches.clear()
    record.transcript = null
    for (const reader of record.sourceReaders) reader.abort()
    record.sourceReaders.clear()
  }

  /**
   * Shows the bound agent and its activity in the summary, announcing a change, or the
   * summary's own change when `moved`.
   */
  private publishAgent(record: Record, moved: boolean): void {
    // Detail changes where the summary may not: a revised request, a subject.
    this.detailed(record)
    this.dialogs.changed(record.summary.id)
    // Murmur writes a headline or gist for what the activity now holds.
    this.murmur?.changed(record.summary.id)
    const agent = record.binding?.agent ?? null
    const ready = this.readyOf(record)
    const activity = record.binding && record.activity ? activitySummary(record.activity) : null
    const telemetry = record.binding && record.telemetry ? telemetrySummary(record.telemetry) : null
    const agentRan = hasRun(record.agents)
    const { summary } = record
    if (
      !moved &&
      summary.agentRan === agentRan &&
      summary.agent === agent &&
      summary.ready === ready &&
      JSON.stringify(summary.activity) === JSON.stringify(activity) &&
      JSON.stringify(summary.telemetry) === JSON.stringify(telemetry)
    )
      return
    record.summary = { ...summary, agentRan, agent, ready, activity, telemetry }
    this.announce(record)
  }

  /**
   * The person pressed Enter at the agent's own prompt, before its first: until its
   * session binds, nothing says it is idle. Should neither a session bind nor its title say
   * a turn runs within `readyReturnMs`, the Enter submitted no prompt, and the prompt
   * still shows.
   */
  private readyEnter(record: Record): void {
    record.readyEntered = true
    record.readyTurned = false
    this.publishAgent(record, false)
    if (record.readyReturn) clearTimeout(record.readyReturn)
    const child = record.process
    record.readyReturn = setTimeout(() => {
      record.readyReturn = undefined
      if (record.process !== child || record.exitQueued || record.binding) return
      if (!record.readyEntered || record.readyTurned) return
      record.readyEntered = false
      this.publishAgent(record, false)
    }, readyReturnMs)
    record.readyReturn.unref()
  }

  /** The agent whose own prompt shows there, with Novadeck's hooks, before any session bound. */
  private readyOf(record: Record): AgentName | null {
    if (record.binding || record.readyEntered) return null
    return this.messaging.shownAgent(record.summary.id) ?? null
  }

  /** Shows a transcript on the record's fresh screen, ahead of its shell's output. */
  private show(record: Record, transcript: string, savedAt: Date | null): void {
    const { screen } = record
    void this.enqueue(record, () => replay(screen, transcript, restoredSeparator(savedAt)))
  }

  private saved(terminalId: string, sessionId?: string): SavedTerminal | undefined {
    let saved: SavedTerminal | undefined
    this.persisting(() => {
      saved = this.options.records?.terminal(terminalId)
    }, "untilStopped")
    return saved && (sessionId === undefined || saved.sessionId === sessionId) ? saved : undefined
  }

  /**
   * Saves what restores the terminal, and with `transcript` its screen too. Nothing is
   * saved once the runner is stopping, or for a terminal that was closed.
   */
  private save(record: Record, transcript: boolean): void {
    // A closed terminal is forgotten for good: work still suspended for it, as an agent's
    // report, must not save it back. An evicted one is kept saved, and still saves.
    if (record.closed) return
    // A failed save leaves the screen marked changed, so a later one tries again, once
    // `saveMs` has passed.
    if (transcript) record.savedAt = performance.now()
    const saved = this.persisting(() =>
      this.options.records?.saveTerminal({
        id: record.summary.id,
        sessionId: record.summary.sessionId,
        handle: record.summary.handle,
        naming: record.naming,
        openedBy: record.openedBy,
        ledBy: record.summary.ledBy,
        work: record.work,
        command: record.summary.command,
        lastProgram: record.summary.lastProgram,
        cwd: record.summary.cwd,
        agents: record.agents,
        promptedAt: record.promptedAt,
        ...(transcript && {
          transcript: this.transcripts
            ? transcriptOf(record.screen, this.options.transcriptChars)
            : null,
        }),
      }),
    )
    if (transcript && saved) record.changed = false
  }

  /**
   * Runs a write to the records, unless the runner is stopping, or with "untilStopped" a
   * read or removal until it has stopped; a failure is logged. True once it is done, or
   * when there are no records.
   */
  private persisting(
    work: () => void,
    until: "untilStopped" | "untilStopping" = "untilStopping",
  ): boolean {
    if (!this.options.records) return true
    if (until === "untilStopping" ? this.stopping : this.stopped) return false
    try {
      work()
      return true
    } catch (error) {
      console.error("Novadeck could not save a terminal:", error)
      return false
    }
  }

  /** Saves changed terminals every so often, so a runner killed at any moment loses little. */
  private saveChanges(): void {
    if (this.saver || this.stopping || !this.options.records) return
    this.saver = setInterval(() => this.persistSome(), this.options.saveMs / 5)
    this.saver.unref()
  }

  private exit(record: Record, ended: { code: number | null; signal: string | null }): void {
    if (record.exitQueued) return
    record.exitQueued = true
    const exit = { ...ended, ranMs: Math.max(0, Math.round(performance.now() - record.startedAt)) }
    void this.enqueue(record, () => {
      record.binding = null
      record.root = null
      record.activity = null
      record.telemetry = null
      this.forgetPrompts(record)
      this.unwatch(record)
      // An exited terminal takes no messages; its agent's are gone until it runs again.
      this.messaging.unregister(record.summary.id)
      this.asks.reconcile(record.summary.id)
      this.doorbell?.forget(record.summary.id)
      this.dialogs.forget(record.summary.id)
      record.summary = {
        ...record.summary,
        exit,
        process: null,
        agent: null,
        ready: null,
        activity: null,
        telemetry: null,
      }
      this.cancelResume(record)
      this.save(record, true)
      this.exits += 1
      record.exitOrder = this.exits
      this.announce(record)
      this.emit(record, { type: "exited", exit })
      record.terminal.finish()
      record.resolveExit()
      this.evict()
    })
  }

  private terminate(record: Record): Promise<void> {
    if (record.closing) return record.closing
    if (record.summary.exit !== null) return record.exited
    record.closing = this.kill(record)
    return record.closing
  }

  /**
   * Ends a terminal's shell and what it started (see the pty's `end`), once its exit is
   * handled. A close already waiting as shutdown begins takes no more than shutdown's own
   * time: each relay or taskkill run within what is left of it, and what a Windows tree
   * left running ends by shutdown's shorter grace.
   */
  private async kill(record: Record): Promise<void> {
    const budget: EndBudget = {
      run: (usual) => this.runMs(usual),
      graceEnds: (began) =>
        this.shutdownBy === undefined
          ? began + treeGraceMs
          : Math.min(began + treeGraceMs, this.shutdownBy - shutdownTreesMs + shutdownTreeGraceMs),
    }
    await Promise.all([
      record.process.end({ graceMs: 1000, treeGraceMs, trees: this.trees, budget }),
      record.exited,
    ])
  }

  /**
   * How long a relay or taskkill run may take now: `usual`, or as the runner shuts down,
   * what is left of its time for terminals' trees, never under a quarter second.
   */
  private runMs(usual: number): number {
    if (this.shutdownBy === undefined) return usual
    return Math.max(250, Math.min(usual, this.shutdownBy - Date.now()))
  }

  /**
   * Drops the oldest exited, unattached records beyond `maxRetained`, and more when a
   * new terminal needs `room` under `maxTerminals`.
   */
  private evict(room = false): void {
    const idle = [...this.records.values()]
      .filter(
        (record) =>
          record.summary.exit !== null &&
          record.terminal.attached === 0 &&
          record.pendingAttachments === 0 &&
          !record.restarting,
      )
      .toSorted((a, b) => a.exitOrder - b.exitOrder)
    let excess = idle.length - this.options.maxRetained
    for (const record of idle) {
      const full = room && this.records.size + this.creating >= this.options.maxTerminals
      if (excess <= 0 && !full) return
      excess -= 1
      this.dispose(record)
      this.records.delete(record.summary.id)
      this.messaging.unregister(record.summary.id)
      this.asks.reconcile(record.summary.id)
      this.doorbell?.forget(record.summary.id)
      this.dialogs.forget(record.summary.id)
      // Its record is let go, but the terminal is kept, saved, until it is closed.
      const saved = this.saved(record.summary.id)
      for (const watcher of this.watchers.keys())
        if (saved) watcher.changed(this.savedSummary(saved))
        else watcher.removed(record.summary)
      this.undetail(record.summary.id)
      // Which chain it belongs to, as `forget` drops it on close; the chain's own times
      // stay until they pass out of the window.
      this.openers.delete(record.summary.id)
    }
  }

  /** Forgets an exited terminal; its screen lasts until its viewers finish reading. */
  private remove(record: Record): void {
    const id = record.summary.id
    if (this.records.get(id) !== record) return
    record.closed = true
    this.records.delete(id)
    for (const watcher of this.watchers.keys()) watcher.removed(record.summary)
    this.undetail(id)
    this.draining.set(id, record)
    this.settle(record)
  }

  private settle(record: Record): void {
    const id = record.summary.id
    if (this.draining.get(id) !== record) return
    if (record.terminal.attached > 0 || record.pendingAttachments > 0) return
    this.draining.delete(id)
    this.dispose(record)
  }

  private dispose(record: Record): void {
    for (const listener of record.listeners) listener.dispose()
    record.screen.dispose()
  }
}
