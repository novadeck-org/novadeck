import { execFile } from "node:child_process"
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants, rmSync, writeFileSync } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { homedir, constants as system } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve as resolvePath } from "node:path"
import { promisify } from "node:util"

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
import { SerializeAddon } from "@xterm/addon-serialize"
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize"
import { UnicodeGraphemesAddon } from "@xterm/addon-unicode-graphemes"
import headless from "@xterm/headless"
import type { Terminal as Screen } from "@xterm/headless"
import * as pty from "node-pty"

import type { PlanText } from "../companions/content.js"
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
  escapeVerdictMs,
  started as fresh,
  summary as activitySummary,
  type Activity,
} from "../harnesses/activity.js"
import { observe, type Binding } from "../harnesses/bindings.js"
import type { BoxProfile } from "../harnesses/box.js"
import { actorOf, agentDetail, requestRef } from "../harnesses/detail.js"
import type { RequestFacts } from "../harnesses/dialogs.js"
import { resumeAvailability } from "../harnesses/eligibility.js"
import type {
  ActivityEvent,
  HarnessEvent,
  PromptShown,
  SessionObserved,
} from "../harnesses/events.js"
import { doorbellLine, quotedLine, silentFor, type Install } from "../harnesses/harness.js"
import { agents, harnesses } from "../harnesses/registry.js"
import { unreplied, withReplies } from "../harnesses/replies.js"
import { followRoot, rootedIn, type Root, type RootChange } from "../harnesses/roots.js"
import { observeTelemetry, telemetrySummary, type Telemetry } from "../harnesses/telemetry.js"
import { typedPromptStart } from "../harnesses/typed-prompts.js"
import { agentLabel } from "../messaging/mailbox.js"
import {
  leaseMargin,
  Messaging,
  type AgentsAnswer,
  type SendAnswer,
} from "../messaging/messaging.js"
import type { MailboxRecords } from "../messaging/records.js"
import type { InstalledShell } from "../shell/install.js"
import { shellLaunch, startsCommands, type ShellLaunch } from "../shell/integration.js"
import { osc7Directory, osc9Directory } from "../shell/osc.js"
import {
  listenForReports,
  unanswered,
  unansweredCalls,
  type Ack,
  type Call,
  type HookAnswer,
  type Report,
  type Reports,
} from "../shell/reports.js"
import { Answers, type AnswerHost, type AnswerOptions } from "./answers.js"
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
import { readDescribeRequest, type DescribeAnswer } from "./describe.js"
import { Dialogs, type DialogsHost, type DialogsOptions } from "./dialogs.js"
import { Doorbell, type DoorbellHost, type DoorbellOptions } from "./doorbell.js"
import {
  foregroundProcess,
  foregroundRuns,
  openFiles,
  processGroup,
  processSetting,
  sampleForeground,
  shellInForeground,
  terminalForeground,
  type Foreground,
} from "./foreground.js"
import { InputQueue, type HoldBudget, type InputHold } from "./input-queue.js"
import { Interrupts, type InterruptHost, type InterruptOptions } from "./interrupts.js"
import { keysOf, splitReports } from "./keys.js"
import { Latest } from "./latest.js"
import { type MouseEncoding, mouseReporting, watchMouseEncoding } from "./mouse.js"
import {
  cleanSummary,
  describedAs,
  descriptionRefusal,
  openedWith,
  renamed as renamedTo,
  titleOf,
  unnamed,
  type Naming,
} from "./naming.js"
import { atPrompt, described, fired, noNudges, nudgeText, type Nudges } from "./nudges.js"
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
import { Prompts, type PromptHost, type PromptOptions } from "./prompts.js"
import type {
  AgentReport,
  ListedTerminal,
  SavedTerminal,
  TerminalIdentity,
  TerminalRecords,
} from "./records.js"
import { freshNonce } from "./ring.js"
import { screenText, type ScreenText } from "./screen.js"
import { snapshot } from "./snapshot.js"
import { Subscription } from "./subscription.js"
import { replay, transcriptOf } from "./transcript.js"
import { transcriptChanges } from "./transcripts.js"
import { TerminalWatcher } from "./watcher.js"
import { judgedFirst, workAfter, type Work } from "./work.js"

const { Terminal } = headless
const OUTPUT_CHARS = 4096

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
  /**
   * The project a session belongs to, whose terminals' agents message each other; each
   * session counts as its own when omitted, or when that cannot be told.
   */
  projectOf?: (sessionId: string) => string | undefined
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
type Retained = { event: TerminalEvent; bytes: number }
type Record = {
  summary: TerminalSummary
  process: pty.IPty
  screen: Screen
  serializer: Serializer
  sequence: number
  history: Retained[]
  historyBytes: number
  subscribers: Map<string, Subscription>
  controller: string | undefined
  chain: Promise<void>
  pendingReads: number
  pendingAttachments: number
  exitQueued: boolean
  /** Closed by the person or an agent, and forgotten: nothing saves it again. */
  closed: boolean
  exited: Promise<void>
  resolveExit: () => void
  listeners: pty.IDisposable[]
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
   * The last binding ended as its process was found gone (`endExited`): a late report of
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
  /** How many titles that may tell a harness's prompt the terminal set, so a stale check is dropped. */
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
  /** What names it: the person's title, an agent's, and its agent's summary of its work. */
  naming: Naming
  /** When its agent is next nudged to describe its work; kept for this runner's lifetime. */
  nudges: Nudges
  /**
   * The root session of the bound agent, which messages, its prompts and its activity are
   * for, followed as its harness's profile says (see `followRoot`); null without one.
   */
  root: Root | null
  /** What the root session worked on, kept with the terminal; null before any did. */
  work: Work | null
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
      readonly attachment: Subscription | undefined
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
  /** `performance.now()` at the last save of its screen, so saves take turns. */
  savedAt: number
} & Omit<Started, "process" | "screen" | "serializer" | "startedAt">

/**
 * A spawned shell with its own headless screen, before it belongs to a record: the token
 * its agents report with, whether it runs a startup command, as one that resumes an
 * agent, and the file holding that command, until the shell takes it or it is cancelled.
 */
type Started = {
  process: pty.IPty
  screen: Screen
  serializer: Serializer
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

/**
 * Resumes a process group hung up as its terminal closed, once the shell has exited. On
 * its own hangup bash takes the terminal back for itself before it exits, so a program
 * still restoring the terminal then, as an agent's TUI does on its way out, is stopped
 * by SIGTTIN or SIGTTOU. Should that stop not have finished as bash exits, the kernel
 * doesn't send the orphaned group its SIGHUP and SIGCONT, and the program stays stopped
 * for good. Once the shell is gone the terminal answers with an error instead, so the
 * resumed program finishes exiting. A group already gone is skipped.
 */
const resumeGroup = (group: number): void => {
  try {
    process.kill(-group, "SIGCONT")
  } catch {
    // Gone.
  }
}

// Variables of Novadeck's own shells and of agent sessions, which a runner started from
// inside one must not pass on.
const inherited = [
  "NOVADECK_TOKEN",
  "NOVADECK_TERMINAL_ID",
  "NOVADECK_REPORT",
  "NOVADECK_REPORT_TOKEN",
  "NOVADECK_HOOK",
  "NOVADECK_MCP",
  "NOVADECK_BIN",
  "NOVADECK_ZDOTDIR",
  "NOVADECK_RESUME",
  "NOVADECK_SHIMS",
  // An agent's own session markers, when Novadeck was started from inside one: an agent
  // in Novadeck's shells would take itself for that session's child. Claude Code, for
  // one, then stops saving its transcript.
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_PROJECT_DIR",
  "CODEX_THREAD_ID",
  "ANTIGRAVITY_CONVERSATION_ID",
]

// Why a request for a new terminal went unanswered.
const unopened = {
  nobody: "Novadeck isn't open to show a new terminal.",
  // Its window may still open it, so the agent should look before asking again.
  gone: "Novadeck's window went away while opening the terminal; it may still open, so check before asking again.",
  late: "Novadeck didn't confirm the new terminal in time; it may still open, so check before asking again.",
}

const sameToken = (a: string, b: string): boolean =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

// How much time a prompt's hook must have left for drift to be read, in milliseconds:
// a git branch and a plan's file, each with its own short timeout.
const driftReadMs = 1_500

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

/** Ends a Windows process and every program it started, which could keep its console open. */
const endTree = async (pid: number): Promise<void> => {
  const windows = process.env.SystemRoot ?? "C:\\Windows"
  await promisify(execFile)(
    join(windows, "System32", "taskkill.exe"),
    ["/T", "/F", "/PID", String(pid)],
    { windowsHide: true, timeout: 5000 },
  )
}

/**
 * Terminals that have drawn. node-pty on Windows queues a kill until then; after, its kill
 * ends the shell at once and closes the console, which ends the programs still attached.
 */
const drawnTerminals = new WeakSet<pty.IPty>()

/**
 * Ends a terminal's program that its first kill left running. On Windows, which has no
 * signals, node-pty throws on one, and later still when it queued the kill until the
 * terminal first drew: its process and every program it started are ended by its id
 * instead. Until its output connects, node-pty names that id 0, which would end the runner
 * itself, so it rejects, and the terminal is taken as ended while node-pty's queued kill
 * closes its console later.
 */
export const forceKill = async (
  child: Pick<pty.IPty, "pid" | "kill">,
  platform: NodeJS.Platform = process.platform,
  end: (pid: number) => Promise<void> | void = endTree,
): Promise<void> => {
  if (platform !== "win32") return child.kill("SIGKILL")
  if (!(child.pid > 0)) throw new Error("The terminal's program has no process id yet.")
  await end(child.pid)
}

/** A signal number's name, such as `SIGKILL`; Windows has no signals. */
const signalName = (signal: number | undefined): string | null => {
  if (!signal || process.platform === "win32") return null
  const entry = Object.entries(system.signals).find(([, value]) => value === signal)
  return entry?.[0] ?? null
}

const positive = (value: number | undefined, fallback: number): number => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1)
    throw new RangeError("Terminal limits must be positive integers.")
  return result
}

/**
 * Owns PTYs for one runner lifetime. Exited, unattached records are retained up to a
 * bound, and evicted oldest first beyond it or when a capped runner needs room.
 */
export class Terminals {
  private readonly records = new Map<string, Record>()
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
      | "projectOf"
      | "doorbell"
      | "prompts"
      | "interrupts"
      | "answers"
      | "install"
      | "hooksTrusted"
      | "items"
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
  private transcripts: boolean
  /** Each session's last default terminal number, without records to keep it. */
  private readonly numbers = new Map<string, number>()
  /** Each terminal's agent reports and asks waiting their turn, in the order they came. */
  private readonly reports = new Map<string, Promise<void>>()
  /** Agents' messages to each other, and how each terminal's agent takes them. */
  private readonly messaging: Messaging
  /** What agents messaging each other, and the runner API about their messages, are answered. */
  private readonly peers: TerminalPeers
  /** Wakes idle agents for their messages; none when switched off. */
  private readonly doorbell: Doorbell | undefined
  private readonly prompts: Prompts
  /** Each terminal's input queue: every piece of work that puts keys in its agent's box. */
  private readonly inputs: InputQueue
  private readonly interrupts: Interrupts
  /** Answers requests through their dialogs, and the dialogs it reads for `agents.detail`. */
  private readonly answers: Answers
  private readonly dialogs: Dialogs
  /** Sessions given out to resume, as agent:session, and the terminal each went to. */
  private readonly claims = new Map<string, string>()
  /** Sessions whose project is going, whose terminals no restart starts again. */
  private readonly closingSessions = new Set<string>()
  /** How many times each harness was disconnected, so a report that waited meanwhile is dropped. */
  private readonly disconnections = new Map<AgentName, number>()
  private creating = 0
  private exits = 0
  private stopping = false
  private shutdownPromise: Promise<void> | undefined

  constructor(options: TerminalOptions = {}) {
    this.options = {
      shell:
        options.shell ??
        (process.platform === "win32"
          ? (process.env.COMSPEC ?? "cmd.exe")
          : (process.env.SHELL ?? "/bin/sh")),
      shellArgs: options.shellArgs,
      env: { ...(options.baseEnv ?? process.env), ...options.env, TERM: "xterm-256color" },
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
    }
    // Child programs do not need the runner's network capability, nor the identity of a
    // Novadeck terminal the runner itself was started from.
    for (const name of inherited) delete this.options.env[name]
    this.transcripts = options.transcripts ?? true
    this.messaging = new Messaging({
      ...(options.mailbox && { records: options.mailbox }),
      // A message is kept while either of its terminals is, running or saved.
      exists: (terminalId) =>
        this.records.has(terminalId) || this.identity(terminalId) !== undefined,
    })
    this.inputs = new InputQueue({
      hold: (terminalId, budget) => this.holdInput(terminalId, budget),
    })
    this.doorbell =
      options.doorbell === false
        ? undefined
        : new Doorbell(this.ringHost(), this.inputs, options.doorbell)
    // A Stop Novadeck continued whose lease lapsed ended its turn after all.
    this.messaging.subscribe((change) => {
      if (change.kind !== "terminal") return
      const record = this.records.get(change.terminalId)
      if (record) this.lapsed(record)
    })
    this.prompts = new Prompts(this.promptHost(), this.inputs, options.prompts)
    this.interrupts = new Interrupts(this.interruptHost(), options.interrupts)
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
      // A new terminal's number is drawn as it is asked for, before anything waits, so
      // terminals asked for together are numbered, and listed, in the order they were.
      const drawn = input.restore ? undefined : this.nextNumber(input.sessionId)
      const saved = input.restore ? this.saved(input.id, input.sessionId) : undefined
      const origin = await this.directory(input.cwd)
      // A saved directory that is gone falls back to the one asked for.
      const cwd = saved ? await this.directory(saved.cwd).catch(() => origin) : origin
      const shell = await this.executable(cwd)
      const integration = await this.shellIntegration()
      const connected = await this.connected(input.resume)
      if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
      // A concurrent creation may have taken the id meanwhile.
      this.available(input.id)
      // Read again after every wait above: a rename meanwhile, as from another window,
      // stands. Nothing waits between this and saving it, and a terminal that can't be
      // numbered fails before its shell starts. Only one saved for this session counts:
      // another's handle and opener mean nothing here, and must never give a terminal
      // there a lead.
      const kept = saved ? this.identity(input.id) : undefined
      // Every new terminal draws its session's next number, for its handle, `t3`, and its
      // default title, "Terminal 03", even one given its own title.
      const number = kept ? undefined : (drawn ?? this.nextNumber(input.sessionId))
      const handle = kept?.handle ?? `t${number}`
      // A title it is created with is the person's, as the client's; the one an agent
      // asked for, as it requested the terminal, is that agent's.
      let naming: Naming = kept?.naming ?? unnamed
      if (input.title !== undefined) naming = renamedTo(naming, input.title)
      if (opener?.title !== undefined) naming = openedWith(naming, opener.title, opener.by)
      const openedBy = kept?.openedBy ?? opener?.by ?? null
      const ledBy = kept ? kept.ledBy : opener?.withBrief ? opener.by : null
      const work = saved?.work ?? null
      const titled = this.titled(naming, { work, handle, openedBy })
      const resume =
        input.command === undefined &&
        input.resume &&
        this.resumable(input.id, input.resume, saved?.agents[input.resume]?.sessionId, connected)
      const startup =
        input.command !== undefined
          ? { command: input.command, required: true }
          : resume && { command: resume.argv.join(" ") }
      const started = this.spawn(shell, cwd, input, integration, startup || undefined)
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
          started: true,
          command: input.command ?? saved?.command ?? null,
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
        sequence: 0,
        history: [],
        historyBytes: 0,
        subscribers: new Map(),
        controller: pending.released ? undefined : ownerId,
        chain: Promise.resolve(),
        pendingReads: 0,
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
        changed: false,
        savedAt: 0,
        submitted: started.resumes,
        startupRuns: started.resumes,
        readyEntered: false,
        naming,
        nudges: noNudges,
        root: null,
        work,
        held: null,
        resizedAt: 0,
        openedBy,
        openerCommand: opener?.command ?? null,
        // Only a session the opener's command started, running an agent, is the opener's.
        awaitsOpened:
          opener !== undefined && !kept && expectedAgent(opener.command, undefined) !== null,
        seenEntry: undefined,
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
        .filter((record) => sessionId === undefined || record.summary.sessionId === sessionId)
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
    // Those the records don't keep, in the order they were asked for too.
    const unrecorded = [...live.values()]
      .filter(({ id }) => !recorded.has(id))
      .toSorted((a, b) => Number(a.handle.slice(1)) - Number(b.handle.slice(1)))
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
   * The next number of a session's terminals, never given twice: from its records when
   * the runner keeps them, else counted in memory. When the records can't give one, no
   * terminal is created, since a number counted afresh could repeat a handle.
   */
  private nextNumber(sessionId: string): number {
    const { records } = this.options
    if (!records) {
      const number = (this.numbers.get(sessionId) ?? 0) + 1
      this.numbers.set(sessionId, number)
      return number
    }
    let number: number | undefined
    this.persisting(() => {
      number = records.nextTerminalNumber(sessionId)
    })
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    if (number === undefined)
      throw new Error(
        "Novadeck couldn't number a new terminal in its workspace database, so it didn't create it.",
      )
    return number
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
  }

  /**
   * Renames a terminal, running or saved, and tells every watcher; one the runner keeps
   * nothing of is TERMINAL_NOT_FOUND.
   */
  rename(input: { terminalId: string; title: string }): void {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    this.name(input.terminalId, input.title)
  }

  /**
   * Takes away the title the person gave a terminal, running or saved, so its title is
   * automatic again (see `titleOf`), and tells every watcher; as `rename` otherwise.
   */
  resetTitle(input: { terminalId: string }): void {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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

  /** The screen of a running terminal once it has drawn what its shell already sent. */
  private async screenOf(terminalId: string): Promise<ScreenText | undefined> {
    const record = this.live(terminalId)
    if (!record) return undefined
    const { process: child } = record
    const text = await this.enqueue(record, () => screenText(record.screen))
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
        record.controller !== size.owner ||
        record.subscribers.get(size.owner) !== size.attachment
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
        if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
          !this.stopping &&
          this.messaging.ringable(terminalId)
        )
      },
      settledSince: (terminalId) => this.messaging.settledSince(terminalId),
      ring: (terminalId, nonce) => this.messaging.ring(terminalId, nonce),
      ringing: (terminalId) => this.messaging.ringing(terminalId),
      ready: (terminalId) => this.messaging.ready(terminalId),
      ringFailed: (terminalId, nonce) => this.messaging.ringFailed(terminalId, nonce),
      screen: (terminalId) => this.screenOf(terminalId),
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
        attachment: record.subscribers.get(ownerId),
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
   * The caller gains control; like closing, it needs control unless nobody holds it.
   * Viewers attach again for the new screen. A failed start leaves the terminal exited.
   */
  async restart(
    input: { terminalId: string; resume?: AgentName | undefined } & Size,
    ownerId: string,
  ): Promise<TerminalSummary> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.record(input.terminalId)
    if (this.closingSessions.has(record.summary.sessionId))
      throw new DomainError("TERMINAL_NOT_FOUND")
    if (record.summary.exit === null || record.restarting)
      throw new DomainError("CONFLICT", "Only an exited terminal can restart.")
    if (record.controller !== undefined && record.controller !== ownerId)
      throw new DomainError("CONTROL_IN_USE")
    record.restarting = true
    const pending = this.pending(ownerId)
    try {
      // The last directory, or where the terminal started once that is gone.
      const cwd = await this.directory(record.summary.cwd).catch(() =>
        this.directory(record.origin),
      )
      const shell = await this.executable(cwd)
      const integration = await this.shellIntegration()
      const connected = await this.connected(input.resume)
      // The swap waits for the old shell's queued work, which still uses the old screen.
      return await this.enqueue(record, () => {
        if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
        // Closed meanwhile, or its project is closing: no shell starts in it again.
        if (
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
          resume ? { command: resume.argv.join(" ") } : undefined,
        )
        if (resume && started.resumes) {
          this.claims.set(resume.key, record.summary.id)
          started.resumeClaim = resume.key
        }
        const earlier =
          this.transcripts && !started.resumes
            ? transcriptOf(record.screen, record.serializer, this.options.transcriptChars)
            : null
        // Earlier attachments ended at the exit; any still draining are dropped.
        for (const subscription of record.subscribers.values()) subscription.cancel()
        record.subscribers.clear()
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
          activity: null,
          telemetry: null,
          watching: null,
          transcript: null,
          // Skipping a sequence number sends any earlier cursor to a fresh snapshot.
          sequence: record.sequence + 1,
          history: [],
          historyBytes: 0,
          controller: pending.released ? undefined : ownerId,
          exitQueued: false,
          closing: undefined,
          submitted: started.resumes,
          startupRuns: started.resumes,
          readyEntered: false,
        })
        // The earlier shell's screen shows above the new one's.
        if (earlier) this.show(record, earlier, null)
        // Restarted to resume the worker's agent session, it stays led; restarted as a plain
        // shell, there is no agent left to lead.
        if (!started.resumes) this.endLead(record)
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
   * Ends the shell and, once it has exited, forgets the terminal. The caller needs
   * control, unless no connection holds it.
   */
  async close(input: { terminalId: string }, ownerId: string): Promise<void> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.records.get(input.terminalId)
    if (!record) {
      // A terminal kept only as saved closes by forgetting it.
      const saved = this.saved(input.terminalId)
      this.forget(input.terminalId)
      if (!saved) throw new DomainError("TERMINAL_NOT_FOUND")
      for (const watcher of this.watchers.keys()) watcher.removed(saved)
      return
    }
    if (record.controller !== undefined && record.controller !== ownerId)
      throw new DomainError("CONTROL_IN_USE")
    await this.terminate(record)
    this.remove(record)
    this.forget(input.terminalId)
  }

  /**
   * Closes every terminal of a project's sessions, running or kept only as saved, as
   * `close` does but whoever controls them, then forgets its agents' messages: the
   * project is going. Its records are the caller's to delete.
   */
  async closeProject(projectId: string, sessionIds: readonly string[]): Promise<void> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const sessions = new Set(sessionIds)
    // Marked first, so a restart under way can't swap a fresh shell in behind the close.
    for (const sessionId of sessions) this.closingSessions.add(sessionId)
    try {
      await this.closeSessions(sessions)
    } finally {
      for (const sessionId of sessions) this.closingSessions.delete(sessionId)
    }
    // Shutting down meanwhile kept what the shells left saved: the project stays, for the
    // next runner to remove.
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    this.messaging.forgetProject(projectId)
  }

  /** Closes every terminal of the sessions, running or kept, whoever controls them. */
  private async closeSessions(sessions: ReadonlySet<string>): Promise<void> {
    const running = [...this.records.values()].filter(({ summary }) =>
      sessions.has(summary.sessionId),
    )
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
        this.forget(terminal.id)
        for (const watcher of this.watchers.keys()) watcher.removed(terminal)
      }
      this.numbers.delete(sessionId)
    }
  }

  /** Forgets what restores the terminal, and the sessions it claimed. */
  private forget(terminalId: string): void {
    // Its items go first, so watchers hear of each before its record cascades them away.
    this.options.items?.terminalClosed(terminalId)
    this.messaging.unregister(terminalId)
    this.doorbell?.forget(terminalId)
    this.dialogs.forget(terminalId)
    for (const [key, claimant] of this.claims) if (claimant === terminalId) this.claims.delete(key)
    this.openers.delete(terminalId)
    this.persisting(() => this.options.records?.removeTerminal(terminalId))
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
      // Its binding ends too: a disconnected harness holds no terminal's foreground.
      if (record.binding?.agent === agent) {
        record.binding = null
        record.activity = null
        record.telemetry = null
        this.unwatch(record)
        this.rebound(record)
        record.summary = {
          ...record.summary,
          agent: null,
          ready: this.readyOf(record),
          activity: null,
          telemetry: null,
        }
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    let subscription: Subscription | undefined
    const detach = () => {
      if (!subscription) {
        if (
          (signal?.aborted || pending.released) &&
          !record.subscribers.has(ownerId) &&
          record.controller === ownerId
        )
          record.controller = undefined
        return
      }
      if (record.subscribers.get(ownerId) !== subscription) return
      record.subscribers.delete(ownerId)
      if (record.controller === ownerId) record.controller = undefined
    }
    const abort = () => {
      subscription?.cancel()
      detach()
    }
    signal?.addEventListener("abort", abort, { once: true })
    try {
      await this.enqueue(record, () => {
        if (signal?.aborted || pending.released) return
        if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
        // Closed while this attachment waited its turn.
        if (this.records.get(input.terminalId) !== record)
          throw new DomainError("TERMINAL_NOT_FOUND")
        if (record.subscribers.has(ownerId)) throw new DomainError("ALREADY_ATTACHED")
        const mode = input.mode ?? "control"
        if (mode === "control" && record.controller !== undefined && record.controller !== ownerId)
          throw new DomainError("CONTROL_IN_USE")
        const cursor = input.afterSequence
        if (
          cursor !== undefined &&
          (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > record.sequence)
        )
          throw new DomainError("INVALID_CURSOR")
        subscription = new Subscription(
          mode,
          this.options.subscriberBytes,
          this.options.ackWindowBytes,
          detach,
          this.options.snapshotBytes,
        )
        record.subscribers.set(ownerId, subscription)
        if (mode === "control") record.controller = ownerId
        else if (record.controller === ownerId) record.controller = undefined
        const first = record.history[0]?.event.sequence ?? record.sequence + 1
        if (cursor !== undefined && cursor >= first - 1) {
          for (const { event } of record.history)
            if (event.sequence > cursor) subscription.push(event)
        } else {
          subscription.push(
            snapshot(
              record.screen,
              record.serializer,
              record.summary,
              record.sequence,
              this.options.snapshotBytes,
              record.mouseEncoding(),
            ),
          )
        }
        if (record.summary.exit !== null) subscription.finish()
      }).finally(() => {
        record.pendingAttachments -= 1
      })
      if (!subscription) return
      // Tells the client that control or observation is established before any event arrives.
      yield { type: "attached", terminalId: input.terminalId, mode: subscription.mode }
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Each delivery waits for consumption ACKs.
        const event = await subscription.next()
        if (event === undefined) return
        yield event
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      subscription?.cancel()
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    const target = await this.peers.target(record, to)
    if (!target.ok) return target
    // Closed, or the runner stopped, while the terminals were described.
    const closing = this.records.get(target.terminalId)
    if (this.stopping || this.records.get(call.terminalId) !== record || !closing)
      return unansweredCalls.close
    // Already on its way out, as another close ended its shell: nothing more to charge.
    if (closing.closing) return refused(`${target.handle} is already closing.`)
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
    await this.terminate(closing)
    // The runner began to stop meanwhile: it keeps the terminal, saved, so it isn't closed.
    if (this.stopping) return unansweredCalls.close
    this.remove(closing)
    this.forget(target.terminalId)
    const gone = this.messaging.goneFrom(call.terminalId)
    return {
      ok: true,
      handle: target.handle,
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
      case "send":
        return this.send(call)
      case "agents":
        return this.agents(call)
      case "describe":
        return this.describe(call)
    }
  }

  /**
   * Describes the caller's own terminal, as its agent asked through Novadeck's MCP server:
   * its agent's title, shown unless the person gave one, and the summary of its work
   * `agents()` lists. A title the person gave stays, unless the agent says the person
   * `asked` for this one, which then becomes theirs; that is taken only in a root turn
   * the person's own prompt started and whose prompt gives it (see `describedAs`), so
   * another agent's message can't rename it. A call without the shell's own token learns
   * nothing more.
   */
  async describe(call: Call): Promise<DescribeAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token))
      return unansweredCalls.describe
    const read = readDescribeRequest(call.request)
    if (!read.ok) return read
    const title = read.request.title.trim()
    const summary = cleanSummary(read.request.summary)
    const refusal = descriptionRefusal(title, summary)
    if (refusal) return refused(refusal)
    // The person's prompt of the turn this call came in, and what other agents' words
    // reached its agent, before anything waits.
    const prompt = this.messaging.personPrompt(call.terminalId)
    const elsewhere = this.peers.seenBy(record)
    // Drift is measured from where its work is now.
    const facts = await this.peers.facts(record)
    if (this.stopping || this.records.get(call.terminalId) !== record)
      return unansweredCalls.describe
    const { naming, kept } = describedAs(record.naming, {
      title,
      summary,
      by: record.summary.handle,
      asked: read.request.asked === true,
      prompt,
      elsewhere,
    })
    record.naming = naming
    record.nudges = described(facts)
    this.retitle(record)
    this.save(record, false)
    return { ok: true, title: record.summary.title, ...(kept && { kept }) }
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

  /** A terminal's threads and messages with their states. */
  messages(terminalId: string): TerminalMessages {
    return this.peers.messages(terminalId)
  }

  /**
   * A terminal's threads and messages, as `messages` lists them, then again on each change
   * to them, to its delivery state or to the pause, until the terminal is gone or `signal`
   * aborts.
   */
  async *watchMessages(terminalId: string, signal?: AbortSignal): AsyncGenerator<TerminalMessages> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
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
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0)
      throw new DomainError("INVALID_CURSOR")
    // A final ACK can arrive after natural stream completion or cancellation.
    record.subscribers.get(ownerId)?.ack(input.sequence)
  }

  release(ownerId: string): void {
    for (const pending of this.pendingOwners.get(ownerId) ?? []) pending.released = true
    for (const record of [...this.records.values(), ...this.draining.values()]) {
      record.subscribers.get(ownerId)?.cancel()
      record.subscribers.delete(ownerId)
      if (record.controller === ownerId) record.controller = undefined
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
    this.messaging.close()
    this.shutdownPromise = this.stop()
    return this.shutdownPromise
  }

  private async stop(): Promise<void> {
    await Promise.all([...this.records.values()].map((record) => this.terminate(record)))
    for (const record of [...this.records.values(), ...this.draining.values()]) {
      for (const subscription of record.subscribers.values()) subscription.cancel()
      record.subscribers.clear()
      record.controller = undefined
      this.dispose(record)
    }
    this.records.clear()
    this.draining.clear()
    this.pendingOwners.clear()
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
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.record(id)
    if (record.controller !== ownerId) throw new DomainError("CONTROL_REQUIRED")
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

  private async executable(cwd: string): Promise<string> {
    const shell = this.options.shell
    const paths =
      isAbsolute(shell) || shell.includes("/") || shell.includes("\\")
        ? [resolvePath(cwd, shell)]
        : (this.options.env.PATH ?? this.options.env.Path ?? "")
            .split(delimiter)
            .map((path) => resolvePath(cwd, path, shell))
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
    const result = record.chain.then(operation)
    record.chain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  private output(record: Record, child: pty.IPty, data: string): void {
    child.pause()
    record.pendingReads += 1
    void this.enqueue(record, async () => {
      // Output a previous run left queued belongs to a screen that is gone.
      if (record.process !== child) return
      await new Promise<void>((resolve) => record.screen.write(data, resolve))
      this.doorbell?.changed(record.summary.id)
      this.dialogs.changed(record.summary.id)
      // Once on the screen: a save while it was drawing may have taken the screen before.
      record.changed = true
      for (let start = 0; start < data.length;) {
        let end = Math.min(start + OUTPUT_CHARS, data.length)
        const last = data.charCodeAt(end - 1)
        if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1
        const chunk = data.slice(start, end)
        this.emit(record, { type: "output", data: chunk })
        start = end
      }
    }).finally(() => {
      record.pendingReads -= 1
      if (record.pendingReads === 0 && !record.exitQueued && record.process === child)
        child.resume()
    })
  }

  private emit(
    record: Record,
    payload:
      | Omit<Extract<TerminalEvent, { type: "output" }>, "terminalId" | "sequence">
      | Omit<Extract<TerminalEvent, { type: "resized" }>, "terminalId" | "sequence">
      | Omit<Extract<TerminalEvent, { type: "exited" }>, "terminalId" | "sequence">,
  ): void {
    const event: TerminalEvent = {
      ...payload,
      terminalId: record.summary.id,
      sequence: ++record.sequence,
    }
    const bytes = Buffer.byteLength(JSON.stringify(event))
    record.history.push({ event, bytes })
    record.historyBytes += bytes
    while (record.historyBytes > this.options.historyBytes)
      record.historyBytes -= record.history.shift()!.bytes
    for (const subscription of record.subscribers.values()) subscription.push(event)
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
    startup?: { readonly command: string; readonly required?: boolean },
  ): Started {
    const { cols, rows } = input
    const id = input.id ?? input.terminalId ?? ""
    const token = randomBytes(24).toString("hex")
    const launch = (withStartup: boolean): ShellLaunch =>
      integration
        ? shellLaunch(shell, integration.paths, this.options.env, {
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
        : { args: [], env: this.options.env, integrated: false, resumes: false }
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
    const screen = new Terminal({ cols, rows, scrollback: 1000, allowProposedApi: true })
    const serializer = new SerializeAddon()
    screen.loadAddon(serializer)
    // Widths as a TUI's own (Ink's) count them, emoji sequences and CJK included: by the
    // default's, a row it erased is a different number of rows, and stale ones stay.
    screen.loadAddon(new UnicodeGraphemesAddon())
    screen.unicode.activeVersion = "15-graphemes"
    const mouseEncoding = watchMouseEncoding(screen)
    try {
      const args = this.options.shellArgs ?? launched.args
      const child = pty.spawn(shell, typeof args === "string" ? args : [...args], {
        name: "xterm-256color",
        cols,
        rows,
        cwd,
        env,
        // Windows' built-in console host can lose input; node-pty ships a newer one.
        useConptyDll: process.platform === "win32",
      })
      return {
        process: child,
        screen,
        serializer,
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
      child.onData((data) => {
        drawnTerminals.add(child)
        this.output(record, child, data)
      }),
      // node-pty can report an exit before it learns the code, e.g. after ending a
      // Windows terminal whose input failed.
      child.onExit(({ exitCode, signal }) =>
        this.exit(record, { code: signal ? null : (exitCode ?? null), signal: signalName(signal) }),
      ),
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
  private prompted(record: Record, child: pty.IPty, cwd: string): void {
    if (record.process !== child) return
    record.promptedAt = Date.now()
    record.submitted = false
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
    this.endBinding(record)
    // An agent whose prompt showed, with no session bound, left with it.
    this.messaging.unshown(record.summary.id)
    this.publishAgent(record, false)
    if (moved) {
      record.summary = { ...record.summary, cwd }
      this.announce(record)
      this.save(record, false)
    }
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
    const decoded = harnesses[report.agent].decode(report)
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
    const shown = harnesses[report.agent].shown?.(report)
    if (events.length === 0 && !shown) return silent
    const { process: child } = record
    const disconnections = this.disconnections.get(report.agent)
    const observes =
      shown !== undefined || events.some((event) => event.type === "session-observed")
    const [foreground, connected] = observes
      ? await Promise.all([shellInForeground(child.pid), this.connected(report.agent)])
      : [undefined, true]
    if (record.process !== child || record.exitQueued) return silent
    // A disconnection while this waited forgot what the report would bring back.
    if (this.disconnections.get(report.agent) !== disconnections) return silent
    // The bound agent process may have exited without the shell showing a prompt, as in
    // tmux or a nested shell: its binding ended with it, and a later process may bind.
    let changed = false
    this.endExited(record)
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
      const same =
        before !== null &&
        next.binding !== null &&
        before.agent === next.binding.agent &&
        before.sessionId === next.binding.sessionId
      if (!same) {
        record.activity = next.binding
          ? fresh(
              event.startedAt,
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
    // The harness compacted the root session's context: it may have lost its description.
    if (
      events.some(
        (event) =>
          event.type === "session-observed" && event.compacted && rootedIn(record.root, event),
      )
    )
      record.nudges = fired(record.nudges, "compaction")
    const told = await this.attributed(record, events)
    // What the root worked on, from its prompts as told, as Antigravity's from its
    // transcript; this terminal's later reports wait for this one.
    if (this.tallyWork(record, told, changes) || changed) this.save(record, false)
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
    this.retitle(record)
    this.save(record, false)
  }

  /**
   * A prompt-time hook's answer, with a nudge to describe the terminal's work when a
   * trigger fired since the last `describe` (see `nudges.ts`): only at the person's
   * prompt, as one line of its own, never in an answer that carries messages or another
   * notice, nor at Stop. Each of the person's prompts counts toward the backstop, and
   * where nothing else is said, whether the work drifted is looked at.
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
    const current = { title: record.summary.title, summary: record.naming.summary }
    return { leaseId: null, stdout: messaging.prompt(nudgeText(current)) }
  }

  /**
   * Follows the terminal's root session after its binding changed or a report's facts,
   * as its harness's profile says, telling messaging how it changed, and tallies what the
   * root worked on; true when that work changed, to be saved.
   */
  private trackRoot(record: Record, events: readonly HarnessEvent[], statusLine: boolean): boolean {
    return this.tallyWork(record, events, this.followRootOf(record, events, statusLine))
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
    if (changes.length > 0) this.messaging.rooted(id, changes)
    // A new root session may not know what the terminal is described as.
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
    // A title from the person's first prompt follows the root session's.
    this.retitle(record)
    return true
  }

  /**
   * The terminal's title after what names it, or its work, changed (see `titleOf`),
   * announced when it differs, as the answer says; the caller saves it.
   */
  private retitle(record: Record): boolean {
    const titled = this.titled(record.naming, {
      work: record.work,
      handle: record.summary.handle,
      openedBy: record.openedBy,
    })
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
    terminal: Pick<ListedTerminal, "work" | "handle" | "openedBy">,
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
    // The person's Enter, judged by when the turn's hook started, as delivery judges it.
    const started = events.find((event) => event.type === "turn-started")
    const told = await typedPromptStart(events, {
      root,
      typedEntry,
      transcript,
      // What was seen of this transcript, not another's.
      seen: record.seenEntry?.transcript === transcript ? record.seenEntry.id : undefined,
      enteredAt: started && this.messaging.pendingSubmission(id, started.startedAt),
      ringing: this.messaging.ringing(id),
      startedWith: record.startedWith,
    })
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
  private screenTitled(record: Record, child: pty.IPty, title: string): void {
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
      // A later title makes this one's answer stale.
      const seq = (record.titles = (record.titles ?? 0) + 1)
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
        const found = await this.harnessIn(record, child, agent)
        if (!found) return
        const trust = await this.promptTrust(record, agent, found.where)
        // Hooks its harness says don't run there: no message can reach it, as long as this
        // title still stands. A late answer marks no terminal the agent has left.
        if (trust === "untrusted" && !binding)
          return this.queue(
            record.summary.id,
            () => {
              if (current() && shown.startedAt > (record.promptedAt ?? 0))
                this.messaging.untrusted(record.summary.id, agent)
              return Promise.resolve()
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
          () => {
            if (!current()) return Promise.resolve()
            // Ended in turn with the reports, so a session bound since is never touched.
            if (exited && record.binding === binding) this.endExited(record)
            this.showPrompt(record, shown, exited ? undefined : replaced)
            return Promise.resolve()
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
    child: pty.IPty,
    agent: AgentName,
  ): Promise<{
    readonly where: Install & { readonly program?: string }
    readonly group: readonly number[]
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
    this.messaging.shown(id, agent, sessionPrefix ?? null, true, shown.startedAt)
    this.endBinding(record, replaced)
  }

  /**
   * Ends the binding of an agent process known to have exited without the shell showing
   * its prompt, as in tmux, a nested shell or `claude ; codex`: whatever shows or binds
   * there next is another agent's. Whether it ended one. Where the platform hides the
   * process (Windows), nothing tells, and the binding stays until the shell's prompt.
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
   * turn's end, else the Escape stands.
   */
  private awaitVerdict(record: Record, { agent, sessionId, instance, startedAt }: ActivityEvent) {
    if (record.verdict) clearTimeout(record.verdict)
    record.verdict = setTimeout(() => {
      record.verdict = undefined
      const { binding } = record
      if (!binding || binding.sessionId !== sessionId || this.stopping) return
      const lapsed: ActivityEvent = {
        type: "turn-escape-lapsed",
        agent,
        sessionId,
        instance,
        startedAt,
      }
      if (this.applyFact(record, lapsed)) this.publishAgent(record, false)
    }, escapeVerdictMs)
    record.verdict.unref()
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
      return next !== undefined
    }
    const next = record.activity && apply(record.activity, record.binding, fact)
    if (next) record.activity = next
    if (next && fact.type === "plan-observed") void this.planned(record, record.binding, fact)
    return Boolean(next)
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
    const agent = record.binding?.agent ?? null
    const ready = this.readyOf(record)
    const activity = record.binding && record.activity ? activitySummary(record.activity) : null
    const telemetry = record.binding && record.telemetry ? telemetrySummary(record.telemetry) : null
    const { summary } = record
    if (
      !moved &&
      summary.agent === agent &&
      summary.ready === ready &&
      JSON.stringify(summary.activity) === JSON.stringify(activity) &&
      JSON.stringify(summary.telemetry) === JSON.stringify(telemetry)
    )
      return
    record.summary = { ...summary, agent, ready, activity, telemetry }
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
    void this.enqueue(record, () => replay(screen, transcript, savedAt))
  }

  private saved(terminalId: string, sessionId?: string): SavedTerminal | undefined {
    let saved: SavedTerminal | undefined
    this.persisting(() => {
      saved = this.options.records?.terminal(terminalId)
    })
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
            ? transcriptOf(record.screen, record.serializer, this.options.transcriptChars)
            : null,
        }),
      }),
    )
    if (transcript && saved) record.changed = false
  }

  /**
   * Runs a write to the records, unless the runner is stopping; a failure is logged.
   * True once it is written, or when there are no records to write to.
   */
  private persisting(work: () => void): boolean {
    if (!this.options.records) return true
    if (this.stopping) return false
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
      this.unwatch(record)
      // An exited terminal takes no messages; its agent's are gone until it runs again.
      this.messaging.unregister(record.summary.id)
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
      for (const subscription of record.subscribers.values()) subscription.finish()
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

  private async kill(record: Record): Promise<void> {
    // The second signal bounds shutdown even for shells that ignore SIGHUP.
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const group = await this.hangUp(record.process)
      const child = record.process
      try {
        child.kill()
      } catch {
        this.exit(record, { code: null, signal: null })
      }
      timer = setTimeout(() => {
        // A Windows terminal that has drawn ran node-pty's kill, which ended its shell, whose
        // id may already name another process.
        const ended = process.platform === "win32" && drawnTerminals.has(child)
        const forced = ended ? Promise.resolve() : forceKill(child)
        forced.then(
          // node-pty on Windows reports an exit only once the console closes, which a program
          // the kill could not end can still keep open.
          () => {
            if (process.platform === "win32") this.exit(record, { code: null, signal: null })
          },
          () => this.exit(record, { code: null, signal: null }),
        )
      }, 1000)
      await record.exited
      if (group !== undefined) resumeGroup(group)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Hangs up the program in the terminal's foreground, as closing a real terminal does,
   * and returns its process group; undefined when there is none to hang up, as on Windows,
   * where no foreground group is known.
   * A shell passes its own hangup on to the jobs it started, but not always: bash does
   * not to a command its prompt hook ran, as a resumed agent is, and would leave it
   * running without a terminal, still holding its session.
   */
  private async hangUp(child: pty.IPty): Promise<number | undefined> {
    const group = await terminalForeground(child.pid)
    if (group === undefined || group === child.pid) return undefined
    try {
      process.kill(-group, "SIGHUP")
    } catch {
      // Gone meanwhile.
    }
    return group
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
          record.subscribers.size === 0 &&
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
    if (record.subscribers.size > 0 || record.pendingAttachments > 0) return
    this.draining.delete(id)
    this.dispose(record)
  }

  private dispose(record: Record): void {
    for (const listener of record.listeners) listener.dispose()
    record.screen.dispose()
  }
}
