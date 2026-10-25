import { transcript as transcriptOf } from "@novadeck/emulator/headless"
import { hookShellSlackMs, type Install } from "@novadeck/harness-core/harness"
import type { AskAnswer, InboxLetter } from "@novadeck/protocol"
import type {
  AgentDetail,
  AgentName,
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
import { relayPath } from "@novadeck/relay"
import { createTerminalHost, type Terminal, type TerminalHost } from "@novadeck/terminal/host"
import { Trees, type ProcessTrees, type Pty, type PtyOptions } from "@novadeck/terminal/pty"
import { afterKeys, emptyLine, withLocale } from "@novadeck/terminal/shell"
import { keysOf } from "@novadeck/tui-input"
import type { PromptOptions } from "@novadeck/tui-input"
import type { InterruptOptions } from "@novadeck/tui-input"

import type { PlanText } from "../companions/content.js"
import type { CompanionItems, TerminalPlace } from "../companions/items.js"
import type { ItemRecord } from "../companions/records.js"
import { DomainError } from "../errors.js"
import { actorOf, agentDetail } from "../harnesses/detail.js"
import { harnesses } from "../harnesses/registry.js"
import { Asks, type AskRecords } from "../messaging/asks.js"
import { type DoorbellOptions } from "../messaging/doorbell.js"
import { Messaging, type AgentsAnswer, type SendAnswer } from "../messaging/messaging.js"
import type { MailboxRecords } from "../messaging/records.js"
import type { Describer } from "../murmur/describer.js"
import { inherited } from "../shell/inherited.js"
import type { InstalledShell } from "../shell/install.js"
import { type Ack, type Call } from "../shell/reports.js"
import type { HintFacts } from "../voice/hint.js"
import { type AnswerOptions } from "./answers.js"
import { Bindings } from "./binding/facts.js"
import { Reports } from "./binding/reports.js"
import { Shown } from "./binding/shown.js"
import { sameToken } from "./callers.js"
import { Calls } from "./calls.js"
import { type CloseAnswer } from "./closes.js"
import { coalesced } from "./coalesce.js"
import { expectedAgent } from "./commands.js"
import { Companion } from "./companion.js"
import { forgetPrompts, markPrompt, murmurHost } from "./describing.js"
import { type DialogsOptions } from "./dialogs.js"
import { Launcher, startedIn, startFailed } from "./launching.js"
import { Murmur, type MurmurTimes } from "./murmur.js"
import { Names } from "./names.js"
import { openedWith, renamed as renamedTo, summaryTitle, unnamed, type Naming } from "./naming.js"
import { noNudges } from "./nudges.js"
import { OpenRequests } from "./opens.js"
import { TerminalPeers } from "./peers.js"
import type { Record } from "./record.js"
import { hasRun, type TerminalRecords } from "./records.js"
import { createTranscriptRedactor, type TranscriptRedactor } from "./redaction.js"
import { restoredSeparator } from "./restored.js"
import { cancelResume, Claims } from "./resumes.js"
import { agentWorking } from "./ringing.js"
import { Sampler, shellProcess } from "./sampling.js"
import { Saves } from "./saving.js"
import type { TranscriptSealer } from "./sealing.js"
import { Streams } from "./streams.js"
import { savedSummaryOf, summaryOf, type AgentSummary } from "./summary.js"
import { transcriptChanges } from "./transcripts.js"
import { Typing } from "./typing.js"

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
  /** How often a changed terminal's transcript is saved, in milliseconds. */
  transcriptMs?: number
  /** How long the last transcripts get as the runner shuts down, in milliseconds. */
  transcriptShutdownMs?: number
  /** Masks secrets in transcripts before they are saved; a worker thread by default. */
  redactor?: TranscriptRedactor
  /** Seals transcripts to save and opens them; none is saved or shown without it. */
  sealer?: TranscriptSealer
  /** How long a restored terminal waits for the sealer's key, in milliseconds. */
  transcriptKeyMs?: number
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
   * The pty: where its program is kept, and as a test plays it, node-pty's `spawn`, the
   * platform its ending follows (this system's when omitted, whatever `platform` says, as
   * real shells run here), and the process trees a Windows terminal's programs end by.
   */
  pty?: PtyOptions & { readonly trees?: ProcessTrees }
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
 * Owns PTYs for one runner lifetime. Exited, unattached records are retained up to a
 * bound, and evicted oldest first beyond it or when a capped runner needs room.
 */
export class Terminals {
  private readonly records = new Map<string, Record>()
  private readonly pendingOwners = new Map<string, Set<{ released: boolean }>>()
  /** Agents' requests for a new terminal, on their way to the client. */
  private readonly opens = new OpenRequests()
  /** Samples running terminals' foreground processes. */
  private readonly sampler: Sampler<Record>
  /** Who reads the terminals: their watchers, and each one's detail and messages readers. */
  private readonly streams: Streams<Record>
  /** Names terminals: their handles, and the titles people give them. */
  private readonly names: Names<Record>
  /** What agents show beside their terminals, and the plans they keep there. */
  private readonly companion: Companion
  /** The agent bound to each terminal: its facts, its sources, and the ends of its binding. */
  private readonly bindings: Bindings
  /** An agent's own prompt as its harness shows it, and whether its hooks run there. */
  private readonly shown: Shown
  /** The hooks' reports and asks of each terminal's agents, taken in the order they came. */
  private readonly reporting: Reports
  /**
   * Everything that types into terminals' agents, through one input queue per terminal:
   * the doorbell, prompts, interrupts and answers, with the dialogs it reads.
   */
  private readonly typing: Typing
  /** The tool calls agents make through Novadeck's MCP server. */
  private readonly calls: Calls
  /** How terminals' shells start, and the runner's shell integration. */
  private readonly launcher: Launcher
  /** Sessions given out to resume, and the terminal each went to. */
  private readonly claims: Claims
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
      | "transcriptMs"
      | "transcriptShutdownMs"
      | "redactor"
      | "sealer"
      | "transcriptKeyMs"
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
  /** Windows' process trees, which a closed terminal's programs are ended by. */
  private readonly trees: ProcessTrees
  /** The terminals' hosting: their limits, close, eviction and shutdown. */
  private readonly host: TerminalHost
  /** How terminals' ptys start, the platform their ending follows, and their scopes. */
  private readonly pty: PtyOptions
  /** Saves terminals for restoring, and reads them back. */
  private readonly saves: Saves
  /** Agents' messages to each other, and how each terminal's agent takes them. */
  private readonly messaging: Messaging
  private readonly asks: Asks
  /** What agents messaging each other, and the runner API about their messages, are answered. */
  private readonly peers: TerminalPeers
  /** Describes terminals with murmur; undefined without a describer. */
  private readonly murmur: Murmur | undefined
  /** Terminals closed in this runner's lifetime, which no create brings back. */
  private readonly closedIds = new Set<string>()
  /** Sessions whose project is going or gone, in which no terminal starts again. */
  private readonly closingSessions = new Set<string>()
  private stopping = false
  /** The runner has stopped: its records may be closed, and nothing reads or forgets them. */
  private stopped = false
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
      ...(options.pty?.scopes && { scopes: options.pty.scopes }),
      platform: options.pty?.platform ?? process.platform,
    }
    this.host = createTerminalHost({
      // Each event as the wire sends it, in its envelope.
      eventBytes: (event, terminalId) =>
        Buffer.byteLength(JSON.stringify({ ...event, terminalId })),
      limits: this.options,
      scrollback: 1000,
      kill: {
        graceMs: 1000,
        treeGraceMs,
        shutdownTreesMs,
        shutdownTreeGraceMs,
      },
      trees: this.trees,
      pty: this.pty,
    })
    this.host.on("evicted", (id, terminal) => this.evicted(id, terminal))
    this.launcher = new Launcher(this.options, {
      stopping: () => this.stopping,
      handlers: {
        report: (report) => this.reporting.queueReport(report),
        ask: (report, deadline) => this.reporting.queueAsk(report, deadline),
        ack: (ack) => this.acknowledge(ack),
        call: (call) => this.calls.call(call),
      },
    })
    this.claims = new Claims({
      boundElsewhere: (terminalId, agent, session) =>
        [...this.records.values()].some(
          (other) =>
            other.summary.id !== terminalId &&
            other.bound?.binding.agent === agent &&
            other.bound.binding.sessionId === session,
        ),
    })
    // Read once now, so the first terminal doesn't wait for it; see `Launcher.environment`.
    // After the deletes, as the relay, or PowerShell, that reads it gets this environment.
    if (this.options.freshPath) void this.launcher.environment()
    this.saves = new Saves(
      {
        records: this.options.records,
        saveMs: this.options.saveMs,
        transcriptMs: positive(options.transcriptMs, 30_000),
        shutdownMs: positive(options.transcriptShutdownMs, 1_000),
        transcriptChars: this.options.transcriptChars,
        transcripts: options.transcripts ?? true,
        redactor: this.options.records
          ? (options.redactor ?? createTranscriptRedactor())
          : undefined,
        sealer: options.sealer,
        keyMs: positive(options.transcriptKeyMs, 5_000),
      },
      {
        stopping: () => this.stopping,
        stopped: () => this.stopped,
        records: () => this.records.values(),
      },
    )
    this.sampler = new Sampler<Record>(this.options.processPollMs, {
      stopping: () => this.stopping,
      records: () => this.records.values(),
      sampled: (record) => {
        this.announce(record)
        this.murmur?.sampled(record.summary.id)
      },
    })
    this.streams = new Streams<Record>({
      stopping: () => this.stopping,
      holds: (terminalId) => this.records.has(terminalId),
      detail: (record) =>
        agentDetail(
          record.summary.id,
          record.bound?.binding ?? null,
          record.bound?.activity ?? null,
          record.bound?.telemetry ?? null,
          this.typing.dialogs.view(record.summary.id),
          this.typing.dialogs.answered(record.summary.id),
        ),
      messages: (terminalId) => this.messages(terminalId),
    })
    this.names = new Names<Record>(Boolean(this.options.records), this.saves, this.streams, {
      stopping: () => this.stopping,
      records: () => this.records.values(),
      record: (terminalId) => this.records.get(terminalId),
      announce: (record) => this.announce(record),
    })
    this.bindings = new Bindings({
      stopping: () => this.stopping,
      messaging: () => this.messaging,
      typing: () => this.typing,
      companion: () => this.companion,
      announce: (record) => this.announce(record),
      save: (record) => this.saves.save(record, false),
      detailed: (record) => this.streams.detailed(record),
      murmurChanged: (terminalId) => this.murmur?.changed(terminalId),
      trackRoot: (record, events, statusLine) =>
        this.reporting.trackRoot(record, events, statusLine),
      rebound: (record) => this.reporting.rebound(record),
      alive,
    })
    this.shown = new Shown({
      messaging: () => this.messaging,
      bindings: () => this.bindings,
      typing: () => this.typing,
      queue: (terminalId, work, fallback) => this.reporting.queue(terminalId, work, fallback),
      connected: (agent) => this.launcher.connected(agent),
      install: (agent) => this.options.install(agent),
      env: () => this.options.env,
      options: () => this.options,
      alive,
    })
    this.reporting = new Reports({
      records: () => this.records,
      messaging: () => this.messaging,
      asks: () => this.asks,
      peers: () => this.peers,
      murmur: () => this.murmur,
      bindings: () => this.bindings,
      shown: () => this.shown,
      typing: () => this.typing,
      companion: () => this.companion,
      save: (record) => this.saves.save(record, false),
      connected: (agent) => this.launcher.connected(agent),
      trees: () => this.trees,
      platform: () => this.options.platform,
    })
    this.companion = new Companion(this.options.items, {
      records: () => this.records,
      saved: (terminalId) => this.saves.saved(terminalId),
      projectFolder: (sessionId) => this.projectFolder(sessionId),
      peers: () => this.peers,
      stopping: () => this.stopping,
    })
    this.messaging = new Messaging({
      ...(options.mailbox && { records: options.mailbox }),
      platform: this.options.platform,
      // A message is kept while either of its terminals is, running or saved.
      exists: (id) => this.records.has(id) || this.saves.identity(id) !== undefined,
      busy: (id) => agentWorking(this.messaging, id, this.live(id)?.bound),
    })
    this.asks = new Asks(
      {
        owner: (id) => this.messaging.inboxOwner(id),
        reply: (id, ask, subject, text, commit, choice) =>
          this.messaging.personReply(id, ask, subject, text, commit, choice),
        replyState: (id) => this.messaging.inboxReply(id),
        forgetReplies: (ids) => this.messaging.forgetResponses(ids),
        changed: (id) => this.streams.mailChanged(id),
        exists: (id) =>
          !this.closedIds.has(id) &&
          (this.records.has(id) || this.saves.identity(id) !== undefined),
      },
      options.asks,
    )
    // A lapsed continuation ends its turn; a late prompt may leave only box doubt to settle.
    // Subscribed before typing's doorbell, which subscribes as it is made.
    this.messaging.subscribe((change) => {
      if (change.kind !== "terminal") return
      const record = this.records.get(change.terminalId)
      if (record) {
        this.reporting.lapsed(record)
        this.typing.settleBox(record)
      }
    })
    this.typing = new Typing(
      {
        platform: this.options.platform,
        doorbell: options.doorbell,
        prompts: options.prompts,
        interrupts: {
          // The queued turn shows working only once its hook comes, which its shell holds back.
          queuedTurnMs: 3_000 + hookShellSlackMs(this.options.platform) / 4,
          ...options.interrupts,
        },
        answers: options.answers,
      },
      {
        stopping: () => this.stopping,
        record: (terminalId) => this.record(terminalId),
        held: (terminalId) => this.records.get(terminalId),
        live: (terminalId) => this.live(terminalId),
        running: (record) => this.running(record),
        keyed: (record, data) => this.keyed(record, data),
        applyFact: (record, fact) => this.bindings.applyFact(record, fact),
        publishAgent: (record, moved) => this.bindings.publishAgent(record, moved),
        detailed: (record) => this.streams.detailed(record),
        endExited: (record) => this.bindings.endExited(record),
        queued: (terminalId, work) =>
          void this.reporting.queue(terminalId, () => Promise.resolve(work()), undefined),
        alive,
        messaging: () => this.messaging,
      },
    )
    // The pause shows in every terminal's listing; anything else only in the terminal's.
    // A burst of changes makes one listing, once this tick.
    const mailChanged = coalesced(
      (terminalId) => this.streams.mailChanged(terminalId),
      "Novadeck could not tell its message watches:",
      "messaging.watch-failed",
    )
    this.messaging.subscribe((change) => {
      if (change.kind === "terminal") mailChanged(change.terminalId)
      else for (const terminalId of this.streams.mailWatched()) mailChanged(terminalId)
    })
    this.peers = new TerminalPeers({
      messaging: this.messaging,
      caller: (terminalId, token) => {
        const record = this.records.get(terminalId)
        return record && !record.terminal.exiting && sameToken(record.token, token)
          ? record
          : undefined
      },
      terminal: (terminalId) => this.records.get(terminalId),
      running: (sessionId) =>
        [...this.records.values()].filter(
          (record) => record.summary.sessionId === sessionId && record.terminal.exit === null,
        ),
      projectFolder: (sessionId) => this.projectFolder(sessionId),
      stopping: () => this.stopping,
    })
    this.murmur = options.describer
      ? new Murmur(
          options.describer,
          murmurHost({
            live: (terminalId) => this.live(terminalId),
            records: () => this.records.values(),
            holds: (terminalId) => this.records.has(terminalId),
            projectFolder: (sessionId) => this.projectFolder(sessionId),
            publishAgent: (record) => this.bindings.publishAgent(record, false),
            names: () => this.names,
            saves: () => this.saves,
            streams: () => this.streams,
          }),
          options.murmurTimes,
        )
      : undefined
    this.calls = new Calls(this.options.openMs, {
      records: () => this.records,
      stopping: () => this.stopping,
      messaging: () => this.messaging,
      asks: () => this.asks,
      peers: () => this.peers,
      opens: () => this.opens,
      companion: () => this.companion,
      launcher: () => this.launcher,
      install: (agent) => this.options.install(agent),
      closingNow: (terminalId) => this.host.closing(terminalId),
      closeForGood: (record) => this.closeForGood(record),
      terminate: (record) => this.terminate(record),
      remove: (record) => this.remove(record),
      forget: (terminalId) => this.forget(terminalId),
      save: (record) => this.saves.save(record, false),
      summarized: (terminalId) => this.murmur?.summarized(terminalId),
      send: (call) => this.send(call),
      agents: (call) => this.agents(call),
    })
    this.launcher.integrate(options.shellFiles)
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
    const place = this.host.reserve(input.id)
    const pending = this.pending(ownerId)
    // An agent's request this answers: read now, as it may stop waiting meanwhile.
    const opener =
      input.requestId === undefined
        ? undefined
        : this.opens.opener(input.requestId, ownerId, input.sessionId)
    try {
      // A new terminal's handle is drawn as it is asked for, before anything waits, so
      // terminals asked for together are named, and listed, in the order they were.
      const drawn = input.restore ? undefined : this.names.next(input.sessionId)
      const saved = input.restore ? this.saves.saved(input.id, input.sessionId) : undefined
      // Read beside the waits below, which it outlasts on Windows; see `Launcher.environment`.
      const environment = this.launcher.environment()
      const origin = await this.launcher.directory(input.cwd)
      // A saved directory that is gone falls back to the one asked for.
      const cwd = saved ? await this.launcher.directory(saved.cwd).catch(() => origin) : origin
      const shell = await this.launcher.executable(cwd, environment)
      const integration = await this.launcher.shellIntegration()
      const connected = await this.launcher.connected(input.resume)
      const env = await environment
      const opened = saved ? await this.saves.open(saved) : null
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
      const kept = saved ? this.saves.identity(input.id) : undefined
      // Every new terminal draws its session's next handle, even one given its own title.
      const handle = kept?.handle ?? drawn ?? this.names.next(input.sessionId)
      // A title it is created with is the person's, as the client's; the one an agent
      // asked for, as it requested the terminal, is that agent's.
      let naming: Naming = kept?.naming ?? unnamed
      if (input.title !== undefined) naming = renamedTo(naming, input.title)
      if (opener?.title !== undefined) naming = openedWith(naming, opener.title, opener.by)
      const openedBy = kept?.openedBy ?? opener?.by ?? null
      const ledBy = kept ? kept.ledBy : opener?.withBrief ? opener.by : null
      const work = saved?.work ?? null
      const command = input.command ?? saved?.command ?? null
      const titled = summaryTitle(naming, { command })
      const resume =
        input.command === undefined &&
        input.resume &&
        this.claims.resumable(
          input.id,
          input.resume,
          saved?.agents[input.resume]?.sessionId,
          connected,
        )
      const startup =
        input.command !== undefined
          ? { command: input.command, required: true }
          : resume && { command: resume.argv.join(" ") }
      const { spec, started } = this.launcher.launch(
        shell,
        cwd,
        input,
        integration,
        env,
        startup || undefined,
      )
      const terminal = startedIn(started, () =>
        place.open(spec, pending.released ? undefined : ownerId),
      )
      // Claimed once its shell runs, so a shell that didn't start holds no session.
      if (resume && started.resumes) {
        this.claims.claim(resume.key, input.id)
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
          process: shellProcess(shell),
          agent: null,
          ready: null,
          activity: null,
          telemetry: null,
        },
        ...started,
        terminal,
        closed: false,
        foreground: undefined,
        origin,
        agents: saved?.agents ?? {},
        bound: null,
        suspended: null,
        watching: null,
        actorWatches: new Map(),
        transcript: null,
        sourceReaders: new Set(),
        promptedAt: saved?.promptedAt ?? null,
        prompts: [],
        line: emptyLine,
        lineEntered: started.resumes,
        changed: false,
        screenChanged: false,
        savedAt: 0,
        submitted: started.resumes,
        startupRuns: started.resumes,
        readyEntered: false,
        naming,
        root: null,
        work,
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
      if (opened && !started.resumes) void this.show(record, opened.text, new Date(opened.at))
      this.listen(record)
      this.announce(record)
      this.sampler.start()
      this.saves.save(record, false)
      this.saves.start()
      return summaryOf(record)
    } finally {
      place.done()
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
        .map((record) => [record.summary.id, summaryOf(record)] as const),
    )
    const kept = this.saves.terminals(sessionId)
    // In the order they were asked for, as the records keep them; a running one they don't
    // keep, as without records, follows.
    const listed = kept.flatMap((terminal) => {
      const running = live.get(terminal.id)
      if (running) return [running]
      return this.host.draining(terminal.id) ? [] : [savedSummaryOf(terminal)]
    })
    const recorded = new Set(kept.map(({ id }) => id))
    // Those the records don't keep, in the order their handles were given.
    const given = (summary: TerminalSummary) => this.names.order(summary.sessionId, summary.handle)
    const unrecorded = [...live.values()]
      .filter(({ id }) => !recorded.has(id))
      .toSorted((a, b) => given(a) - given(b))
    return [...listed, ...unrecorded]
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
    this.names.name(input.terminalId, input.title)
  }

  /**
   * Takes away the title the person gave a terminal, running or saved, so its title is
   * automatic again (see `titleOf`), and tells every watcher; as `rename` otherwise.
   */
  resetTitle(input: { terminalId: string }): void {
    if (this.stopping) throw new DomainError("CLOSING")
    this.names.name(input.terminalId, null)
    // A summary written while the person's title showed names the terminal now.
    this.murmur?.summarized(input.terminalId)
  }

  get(terminalId: string): TerminalSummary {
    return summaryOf(this.record(terminalId))
  }

  write(input: { terminalId: string; data: string }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    // While the doorbell's test paste, or an answer's keys, are on screen, the person's
    // keys wait their turn (see `keyed`, which they reach when they count).
    record.terminal.input(input.data)
  }

  /**
   * Gives the terminal's agent a prompt as the person would paste and submit it (see
   * `Prompts`), once those before it in the terminal's input queue are done.
   */
  prompt(input: { terminalId: string; text: string }): Promise<void> {
    return this.typing.prompt(input.terminalId, input.text)
  }

  /**
   * Answers a request waiting on the person through its dialog in the agent's TUI, as the
   * person would with its keys (see `Answers`). No message of the person's, nor a doorbell
   * ring, comes between the answer and the words that follow it.
   */
  answer(input: { terminalId: string; request: string; answer: RequestAnswer }): Promise<void> {
    return this.typing.answer(input.terminalId, input.request, input.answer)
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
  interrupt(input: { terminalId: string }): Promise<InterruptResult> {
    return this.typing.interrupt(input.terminalId)
  }

  /**
   * What the person's keys do beyond reaching the terminal, for what watches them: whether
   * a request waits on them, and what they did to the agent's box, which messaging's
   * delivery decides. The terminal's own reports, such as a focus report or, while the TUI
   * asked for them, the mouse's scroll, are no keys.
   */
  private keyed(record: Record, data: string): void {
    const agent = record.bound?.binding.agent
    const queueKey = agent && harnesses[agent].messaging.queueKey
    const keys = keysOf(data, queueKey, record.terminal.reporting())
    if (keys.length === 0) return
    // A prompt whose trust is still being checked is no longer known empty after a key.
    record.titles = (record.titles ?? 0) + 1
    // Typing before the shell resumes its agent cancels the resume, so the shell gets
    // what was typed. A cancelled resume leaves its session free for another terminal.
    const claim = record.resumeClaim
    if (cancelResume(record)) {
      record.startupRuns = false
      // The person took the terminal over before its agent ever ran: nothing to lead.
      this.bindings.endLead(record)
      this.claims.cancel(claim, record.summary.id)
    }
    if (/[\r\n]/.test(data)) record.submitted = true
    // A line with something on it is a command; Enter on an empty prompt is not.
    const line = afterKeys(record.line, data)
    record.line = line.line
    if (line.entered) record.lineEntered = true
    if (keys.some(({ kind }) => kind === "enter") && this.bindings.readyOf(record))
      this.bindings.readyEnter(record)
    this.messaging.keys(
      record.summary.id,
      keys.map(({ kind }) => kind),
      (record.bound?.activity.pending.length ?? 0) > 0,
    )
    this.bindings.escaped(record)
    if (this.messaging.untrustedAgent(record.summary.id)) this.shown.recheckTrust(record)
  }

  /** The record of a terminal that is running, if it is. */
  private live(terminalId: string): Record | undefined {
    const record = this.records.get(terminalId)
    return record && !record.terminal.exiting && record.terminal.exit === null ? record : undefined
  }

  resize(input: { terminalId: string; cols: number; rows: number }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    record.terminal.resize(input.cols, input.rows, ownerId)
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
    // Closed, even meanwhile, or its project is closing: no shell starts in it again.
    const check = () => {
      if (
        record.closed ||
        this.records.get(input.terminalId) !== record ||
        this.closingSessions.has(record.summary.sessionId)
      )
        throw new DomainError("TERMINAL_NOT_FOUND")
    }
    const pending = this.pending(ownerId)
    try {
      return await this.host.restart(input.terminalId, ownerId, {
        check,
        prepare: async () => {
          const environment = this.launcher.environment()
          // The last directory, or where the terminal started once that is gone.
          const cwd = await this.launcher
            .directory(record.summary.cwd)
            .catch(() => this.launcher.directory(record.origin))
          const shell = await this.launcher.executable(cwd, environment)
          const integration = await this.launcher.shellIntegration()
          const connected = await this.launcher.connected(input.resume)
          const env = await environment
          return (restart) => {
            const resume =
              input.resume &&
              this.claims.resumable(
                record.summary.id,
                input.resume,
                record.agents[input.resume]?.sessionId,
                connected,
              )
            const { spec, started } = this.launcher.launch(
              shell,
              cwd,
              input,
              integration,
              env,
              resume ? { command: resume.argv.join(" ") } : undefined,
            )
            const earlier =
              this.saves.transcripts && !started.resumes
                ? transcriptOf(record.terminal.screen, this.options.transcriptChars)
                : null
            let shown = Promise.resolve()
            try {
              // Earlier attachments ended at the exit; any still draining are dropped, and any
              // earlier cursor gets a fresh snapshot.
              restart(spec, pending.released ? undefined : ownerId, () => {
                if (resume && started.resumes) {
                  this.claims.claim(resume.key, record.summary.id)
                  started.resumeClaim = resume.key
                }
                forgetPrompts(record)
                Object.assign(record, started, {
                  summary: {
                    ...record.summary,
                    cwd,
                    process: shellProcess(shell),
                    agent: null,
                    ready: null,
                    activity: null,
                    telemetry: null,
                  } satisfies AgentSummary,
                  foreground: undefined,
                  ...this.bindings.restarted(),
                  shellName: shellProcess(shell)?.name,
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
                shown = earlier ? this.show(record, earlier, null) : Promise.resolve()
                // Restarted to resume the worker's agent session, it stays led; restarted as a plain
                // shell, there is no agent left to lead.
                if (!started.resumes) this.bindings.endLead(record)
                // The earlier shell's job and what murmur kept of it are not the new one's.
                this.murmur?.gone(record.summary.id)
                this.register(record, input.resume ?? null)
              })
            } catch (error) {
              throw startFailed(started, error)
            }
            this.announce(record)
            this.sampler.start()
            // Saved at once, once the earlier screen is on it.
            void shown.then(() => this.saves.save(record, true))
            return summaryOf(record)
          }
        },
      })
    } finally {
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
      const saved = this.saves.saved(input.terminalId)
      this.forget(input.terminalId)
      if (!saved) throw new DomainError("TERMINAL_NOT_FOUND")
      this.streams.removed(saved)
      return
    }
    this.closeForGood(record)
    await this.terminate(record)
    this.remove(record)
    // What its programs left on their way out, as an agent registering again, goes too.
    this.forget(input.terminalId)
  }

  /**
   * Starts closing a running terminal for good: watchers hear it is gone, nothing
   * announces or saves it again, and what restores it is forgotten before its shell ends.
   */
  private closeForGood(record: Record): void {
    if (record.closed) return
    record.closed = true
    this.closedIds.add(record.summary.id)
    this.streams.removed(record.summary)
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
      for (const terminal of this.saves.terminals(sessionId)) {
        this.closedIds.add(terminal.id)
        this.forget(terminal.id)
        this.streams.removed(terminal)
      }
      this.names.forgetSession(sessionId)
    }
  }

  /** Forgets what restores the terminal, and unless told not to, the sessions it claimed. */
  private forget(terminalId: string, { claims = true } = {}): void {
    // Its items go first, so watchers hear of each before its record cascades them away.
    this.companion.closed(terminalId)
    this.messaging.unregister(terminalId)
    this.asks.reconcile(terminalId)
    this.typing.forget(terminalId)
    this.murmur?.gone(terminalId)
    if (claims) this.claims.release(terminalId)
    this.calls.forgetOpener(terminalId)
    // Forgotten while the runner stops too, as a close then still stands.
    this.saves.remove(terminalId)
  }

  /**
   * Where a terminal kept by the runner is, running or saved, as items shown in it or
   * placed on it need: its session, handle, directory and project folder.
   */
  place(terminalId: string): TerminalPlace | undefined {
    return this.companion.place(terminalId)
  }

  /**
   * What a running terminal's dictation hint is made of (see `dictationHint`), but its
   * project's name, with the files shown in its bar. Undefined for a terminal not running
   * here.
   */
  hintFacts(terminalId: string): Promise<Omit<HintFacts, "project"> | undefined> {
    return this.companion.hintFacts(terminalId)
  }

  /**
   * A plan presented as text, as the terminal it came from has it live while it still
   * runs the plan's session: the latest its actor presented, and when.
   */
  livePlan(item: ItemRecord): PlanText | undefined {
    return this.companion.livePlan(item)
  }

  /** The session `agent` last reported in the terminal, live or saved; null when none. */
  reportedSession(terminalId: string, agent: AgentName): string | null {
    const live = this.records.get(terminalId)
    return (live ?? this.saves.saved(terminalId))?.agents[agent]?.sessionId ?? null
  }

  /** Forgets every session `agent` reported, as once it is disconnected. */
  forgetAgent(agent: AgentName): void {
    this.reporting.disconnected(agent)
    for (const record of this.records.values()) {
      const { [agent]: _forgotten, ...rest } = record.agents
      record.agents = rest
      const agentRan = hasRun(rest)
      // Its binding ends too: a disconnected harness holds no terminal's foreground.
      if (record.bound?.binding.agent === agent) this.bindings.forgotten(record)
      else if (record.summary.agentRan !== agentRan) {
        record.summary = { ...record.summary, agentRan }
        this.announce(record)
      }
    }
    this.claims.forgetAgent(agent)
    this.saves.forgetAgent(agent)
  }

  /** Turning transcripts off forgets every saved one; turning them on saves each anew. */
  keepTranscripts(enabled: boolean): void {
    if (this.stopping) throw new DomainError("CLOSING")
    this.saves.keep(enabled)
  }

  /** Saves every terminal's changes now, as before the system shuts down. */
  persist(): void {
    this.saves.persist()
  }

  /** Streams an `attached` marker once established, then snapshot or replay and live events. */
  async *attach(
    input: Attach,
    ownerId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TerminalAttached | TerminalEvent> {
    const record = this.record(input.terminalId)
    const pending = this.pending(ownerId)
    const { terminalId } = input
    try {
      for await (const event of this.host.attach(
        terminalId,
        ownerId,
        { after: input.afterSequence, mode: input.mode ?? "control" },
        {
          ...(signal && { signal }),
          released: () => pending.released,
          // Closed, or closing, while this attachment waited its turn.
          check: () => {
            if (record.closed || this.records.get(terminalId) !== record)
              throw new DomainError("TERMINAL_NOT_FOUND")
          },
        },
      ))
        yield event.type === "attached"
          ? { type: "attached", terminalId, mode: event.mode }
          : { ...event, terminalId }
    } finally {
      this.complete(ownerId, pending)
    }
  }

  /**
   * Streams a `changed` for every terminal, `synced`, then later changes, until the
   * signal aborts, the owner is released, or the runner shuts down.
   */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<TerminalChange> {
    if (this.stopping) throw new DomainError("CLOSING")
    yield* this.streams.watch(ownerId, () => this.list(), signal)
  }

  /**
   * What the agent in a terminal does, in detail: a snapshot, then another on each change,
   * until the terminal is closed or `signal` aborts.
   */
  async *detail(terminalId: string, signal?: AbortSignal): AsyncGenerator<AgentDetail> {
    if (this.stopping) throw new DomainError("CLOSING")
    const record = this.record(terminalId)
    yield* this.streams.watchDetail(record, signal)
  }

  /** Closes another terminal of the caller's project and session (see `Calls.closePeer`). */
  closePeer(call: Call): Promise<CloseAnswer> {
    return this.calls.closePeer(call)
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
    yield* this.streams.watchMessages(terminalId, signal)
  }

  /** Pauses messaging across the whole runner, or resumes it. */
  pauseMessages(paused: boolean): void {
    this.peers.pause(paused)
  }

  /** Releases a held thread, and its pair's other held threads. */
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
    const { bound, transcript: root } = record
    const source = bound && harnesses[bound.binding.agent].transcripts
    const native = bound && actorOf(bound.binding, bound.activity, actor)
    if (!bound || !source || !root || native === undefined) throw new DomainError("NOT_FOUND")
    const path = await source.locate(root, bound.binding.sessionId, native)
    if (!path || record.bound?.binding !== bound.binding) throw new DomainError("NOT_FOUND")
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
    const terminal = this.host.terminal(input.terminalId)
    if (!terminal) throw new DomainError("TERMINAL_NOT_FOUND")
    // A final ACK can arrive after natural stream completion or cancellation.
    terminal.ack(ownerId, input.sequence)
  }

  release(ownerId: string): void {
    for (const pending of this.pendingOwners.get(ownerId) ?? []) pending.released = true
    this.host.release(ownerId)
    this.streams.release(ownerId)
    this.opens.release(ownerId)
    this.companion.release(ownerId)
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise
    // The last save happens while every shell still runs; ending them saves nothing, so
    // what they print on the way out cannot replace it. Transcripts get a short pass (`Saves.finish`).
    const last = this.saves.shutdown()
    this.stopping = true
    this.sampler.stop()
    this.saves.stop()
    this.streams.finishWatchers()
    this.opens.finish()
    this.companion.shutdown()
    this.streams.finishReaders()
    for (const record of this.records.values()) this.bindings.unwatch(record)
    this.typing.close()
    this.asks.close()
    this.messaging.close()
    this.shutdownPromise = Promise.all([last, this.stop()]).then(() => undefined)
    return this.shutdownPromise
  }

  private async stop(): Promise<void> {
    this.murmur?.stop()
    await this.host.shutdown()
    this.records.clear()
    this.pendingOwners.clear()
    this.stopped = true
    await (await this.launcher.integrated())?.reports.close()
  }

  private record(id: string): Record {
    const record = this.records.get(id)
    if (!record) throw new DomainError("TERMINAL_NOT_FOUND")
    return record
  }

  private available(id: string): void {
    // A closed terminal's id stays taken while its record drains to attached viewers.
    if (this.records.has(id) || this.host.draining(id)) {
      throw new DomainError("CONFLICT", "Terminal id is already taken.")
    }
  }

  /** Reports the record's current summary to every watcher. */
  private announce(record: Record): void {
    // A closed terminal's watchers already heard it is gone; its exit must not add it back.
    if (!record.closed) this.streams.changed(() => summaryOf(record))
    this.streams.detailed(record)
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
    if (
      record.terminal.exit !== null ||
      record.terminal.exiting ||
      this.host.closing(record.summary.id)
    )
      throw new DomainError("TERMINAL_EXITED")
  }

  /** Reacts to the terminal: what it draws, its exit, its size, title and prompts. */
  private listen(record: Record): void {
    const { terminal } = record
    terminal.on("drawn", () => {
      this.typing.doorbellChanged(record.summary.id)
      this.typing.dialogsChanged(record.summary.id)
      // Once on the screen: a save while it was drawing may have taken the screen before.
      record.screenChanged = true
    })
    terminal.on("exit", () => this.exited(record))
    // Its summary's size is the terminal's own, drawn now.
    terminal.on("resized", () => {
      this.announce(record)
    })
    // A harness may tell by the title it sets that its prompt shows.
    terminal.on("title", (title, child) => {
      record.title = title
      this.shown.screenTitled(record, child, title)
    })
    terminal.on("cwd", (cwd, child) => this.prompted(record, child, cwd))
    // No marker keeps a line that is no longer the one it marked.
    terminal.on("reset", () => forgetPrompts(record))
    // What the person's keys did, once they count.
    terminal.on("keys", (keys) => this.keyed(record, keys))
  }

  /**
   * The shell showed its prompt in `cwd`: its agent is no longer in the foreground. A
   * shell resuming an agent reports its first prompt once the agent exits, so a resume
   * command still waiting by now was never taken.
   */
  private prompted(record: Record, child: Pty, cwd: string): void {
    if (record.terminal.pty !== child) return
    record.promptedAt = Date.now()
    // Whether a non-empty line was entered since the last prompt: a command may have run.
    const entered = record.lineEntered
    record.lineEntered = false
    record.line = emptyLine
    record.submitted = false
    markPrompt(record, entered)
    record.readyEntered = false
    // Whether the startup command (an agent opened or resumed there) ran, so this prompt
    // is the first after it ended.
    const ran = record.startupRuns && !cancelResume(record)
    record.startupRuns = false
    record.changed = true
    const moved = cwd !== record.summary.cwd
    const binding = record.bound?.binding ?? null
    // The agent it was started to run left without ever binding a session (a failed
    // login, Ctrl-C at startup, a declined trust): the lead it had ends with it. One bound
    // ends the lead only once its process is gone; suspended with Ctrl+Z it still runs,
    // and comes back with `fg`. A process Novadeck can't name can't be told suspended.
    if (binding === null) {
      // Or the agent a Ctrl+Z left suspended, found gone with no session bound since.
      if (ran || (record.suspended !== null && !alive(record.suspended)))
        this.bindings.endLead(record)
    } else if (binding.instance && alive(binding.instance)) {
      record.suspended = binding.instance
    } else this.bindings.endLead(record)
    // Nothing came of the agent the shell was opened to run: it is a plain shell now.
    if (binding === null && ran) record.expecting = null
    // An agent whose prompt showed, with no session bound, left with it: first, so the
    // binding's end never shows its prompt ready again.
    this.messaging.unshown(record.summary.id)
    this.bindings.endBinding(record)
    if (moved) {
      record.summary = { ...record.summary, cwd }
      this.announce(record)
      this.saves.save(record, false)
    }
    // Every return to the prompt names the shell again (murmur skips one that shows what it
    // last described), but not one an agent just left: that is its agent's, till the next.
    if (binding === null || moved) this.murmur?.prompted(record.summary.id, entered || moved)
  }

  /** Shows a transcript on the record's fresh screen, ahead of its shell's output. */
  private show(record: Record, transcript: string, savedAt: Date | null): Promise<void> {
    return record.terminal.replay(transcript, restoredSeparator(savedAt))
  }

  /** The shell exited: the agent layer lets go of it, before its viewers read the exit. */
  private exited(record: Record): void {
    this.bindings.exited(record)
    forgetPrompts(record)
    // An exited terminal takes no messages; its agent's are gone until it runs again.
    this.messaging.unregister(record.summary.id)
    this.asks.reconcile(record.summary.id)
    this.typing.forget(record.summary.id)
    record.summary = {
      ...record.summary,
      process: null,
      agent: null,
      ready: null,
      activity: null,
      telemetry: null,
    }
    cancelResume(record)
    this.saves.save(record, true)
    this.announce(record)
  }

  /** Ends a terminal's shell and what it started (see the host's `terminate`). */
  private terminate(record: Record): Promise<void> {
    return this.host.terminate(record.summary.id)
  }

  /** The host let an exited terminal go: its record goes, but it's kept saved until closed. */
  private evicted(id: string, terminal: Terminal): void {
    const record = this.records.get(id)
    if (record?.terminal !== terminal) return
    this.records.delete(id)
    this.messaging.unregister(id)
    this.asks.reconcile(id)
    this.typing.forget(id)
    // Its record is let go, but the terminal is kept, saved, until it is closed.
    const saved = this.saves.saved(id)
    if (saved) this.streams.changed(() => savedSummaryOf(saved))
    else this.streams.removed(record.summary)
    this.streams.end(id)
    // Which chain it belongs to, as `forget` drops it on close; the chain's own times stay
    // until they pass out of the window.
    this.calls.forgetOpener(id)
  }

  /** Forgets an exited terminal; its screen lasts until its viewers finish reading. */
  private remove(record: Record): void {
    const id = record.summary.id
    if (this.records.get(id) !== record) return
    record.closed = true
    this.records.delete(id)
    this.streams.removed(record.summary)
    this.streams.end(id)
    this.host.remove(id)
  }
}
