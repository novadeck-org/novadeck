import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { constants, rmSync, writeFileSync } from "node:fs"
import { access, realpath, stat } from "node:fs/promises"
import { constants as system } from "node:os"
import { basename, delimiter, isAbsolute, join, resolve as resolvePath } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type {
  AgentDetail,
  AgentName,
  AgentShown,
  ArtifactContent,
  ForegroundProcess,
  TerminalAttached,
  TerminalChange,
  TerminalEvent,
  TerminalSummary,
  PlanContent,
  TranscriptChange,
} from "@novadeck/protocol"
import { SerializeAddon } from "@xterm/addon-serialize"
import type { SerializeAddon as Serializer } from "@xterm/addon-serialize"
import headless from "@xterm/headless"
import type { Terminal as Screen } from "@xterm/headless"
import * as pty from "node-pty"

import { DomainError } from "../errors.js"
import {
  apply,
  started as fresh,
  summary as activitySummary,
  type Activity,
} from "../harnesses/activity.js"
import { observe, type Binding } from "../harnesses/bindings.js"
import { actorOf, agentDetail, planOf } from "../harnesses/detail.js"
import { resumeAvailability } from "../harnesses/eligibility.js"
import type { HarnessEvent, SessionObserved } from "../harnesses/events.js"
import { harnesses } from "../harnesses/registry.js"
import { observeTelemetry, telemetrySummary, type Telemetry } from "../harnesses/telemetry.js"
import type { InstalledShell } from "../shell/install.js"
import { shellLaunch, type ShellLaunch } from "../shell/integration.js"
import { osc7Directory, osc9Directory } from "../shell/osc.js"
import {
  listenForReports,
  unanswered,
  type Call,
  type Report,
  type Reports,
} from "../shell/reports.js"
import { capture, readRequest, remember, type Artifact, type PresentAnswer } from "./artifacts.js"
import {
  sampleForeground,
  shellInForeground,
  terminalForeground,
  type Foreground,
} from "./foreground.js"
import { Latest } from "./latest.js"
import { planContent, planStamp } from "./plans.js"
import type { AgentReport, SavedTerminal, TerminalRecords } from "./records.js"
import { snapshot } from "./snapshot.js"
import { Subscription } from "./subscription.js"
import { replay, transcriptOf } from "./transcript.js"
import { transcriptChanges } from "./transcripts.js"
import { Watcher } from "./watcher.js"

const { Terminal } = headless
const OUTPUT_CHARS = 4096

export type TerminalOptions = {
  shell?: string
  shellArgs?: readonly string[]
  env?: NodeJS.ProcessEnv
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
   * Whether NovaDeck's plugin is installed into the harness: a disconnected one resumes
   * nothing and its reports are ignored. Every harness counts as connected when omitted.
   */
  connected?: (agent: AgentName) => Promise<boolean>
  /** Whether terminals' transcripts are kept, until `keepTranscripts` changes it. */
  transcripts?: boolean
  /** How often changed terminals are saved, in milliseconds. */
  saveMs?: number
  /** The longest transcript kept per terminal, in characters. */
  transcriptChars?: number
  /** How often a followed plan's file is looked at for changes, in milliseconds. */
  planPollMs?: number
  /** The folder of the project a session belongs to, which names the files its agents show. */
  projectFolder?: (sessionId: string) => string | undefined
}

type Create = {
  id: string
  sessionId: string
  cwd: string
  cols: number
  rows: number
  restore?: boolean | undefined
  resume?: AgentName | undefined
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
  /** What the bound agent is doing, as its hooks said; null without a binding. */
  activity: Activity | null
  /** The bound agent's tokens and quotas, as its records said; null until they did. */
  telemetry: Telemetry | null
  /** Stops following the bound session's own sources, as its transcript. */
  watching: AbortController | null
  /** The bound session's transcript, where its hooks named one. */
  transcript: string | null
  /** Ends the `agents.transcript` and `agents.plan` streams reading the bound session's. */
  sourceReaders: Set<AbortController>
  /** When the shell last showed its prompt, in epoch milliseconds. */
  promptedAt: number | null
  /** What its agents showed the person, oldest first, by id; kept across its shells, never saved. */
  shown: ReadonlyMap<string, Artifact>
  /** Unsaved changes: output, directory, or prompts. */
  changed: boolean
  /**
   * Whether a line was entered since the last prompt, or the shell resumed an agent, so
   * a program may be running.
   */
  submitted: boolean
  /** `performance.now()` at the last save of its screen, so saves take turns. */
  savedAt: number
} & Omit<Started, "process" | "screen" | "serializer" | "startedAt">

/**
 * A spawned shell with its own headless screen, before it belongs to a record: the token
 * its agents report with, whether it resumes an agent, and the file holding the command
 * that does, until the shell takes it or it is cancelled.
 */
type Started = {
  process: pty.IPty
  screen: Screen
  serializer: Serializer
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

// Variables of NovaDeck's own shells and of agent sessions, which a runner started from
// inside one must not pass on.
const inherited = [
  "NOVADECK_TOKEN",
  "NOVADECK_TERMINAL_ID",
  "NOVADECK_REPORT",
  "NOVADECK_REPORT_TOKEN",
  "NOVADECK_HOOK",
  "NOVADECK_BIN",
  "NOVADECK_ZDOTDIR",
  "NOVADECK_RESUME",
  "NOVADECK_SHIMS",
  // An agent's own session markers, when NovaDeck was started from inside one: an agent
  // in NovaDeck's shells would take itself for that session's child. Claude Code, for
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

// Input the terminal itself sends, not typing: focus reports, cursor-position and device
// reports, and answers to colour queries.
const terminalReply =
  // eslint-disable-next-line no-control-regex -- These replies are control sequences.
  /^(?:\x1b\[[IO]|\x1b\[\??[\d;]*[Rcn]|\x1b\[>[\d;]*c|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+$/

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
  private readonly watchers = new Map<Watcher, string>()
  /** Each terminal's `agents.detail` readers. */
  private readonly details = new Map<string, Set<Latest<AgentDetail>>>()
  /** Each terminal's `agents.shown` readers. */
  private readonly showings = new Map<string, Set<Latest<AgentShown>>>()
  private sampler: ReturnType<typeof setInterval> | undefined
  private saver: ReturnType<typeof setInterval> | undefined
  private readonly options: Required<
    Omit<
      TerminalOptions,
      | "env"
      | "shellArgs"
      | "shellFiles"
      | "records"
      | "shims"
      | "connected"
      | "transcripts"
      | "projectFolder"
    >
  > & {
    env: NodeJS.ProcessEnv
    shellArgs: readonly string[] | undefined
    records: TerminalRecords | undefined
    projectFolder: ((sessionId: string) => string | undefined) | undefined
    shims: () => Promise<readonly AgentName[]>
    connected: (agent: AgentName) => Promise<boolean>
  }
  private readonly integration: Promise<Integration | undefined>
  private transcripts: boolean
  /** Agent reports waiting their turn. */
  private reports = Promise.resolve()
  /** Sessions given out to resume, as agent:session, and the terminal each went to. */
  private readonly claims = new Map<string, string>()
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
      env: { ...process.env, ...options.env, TERM: "xterm-256color" },
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
      planPollMs: positive(options.planPollMs, 500),
      projectFolder: options.projectFolder,
    }
    // Child programs do not need the runner's network capability, nor the identity of a
    // NovaDeck terminal the runner itself was started from.
    for (const name of inherited) delete this.options.env[name]
    this.transcripts = options.transcripts ?? true
    this.integration = this.integrate(options.shellFiles)
  }

  /** Listens for agent reports once the shell files are written; shells start plainly without. */
  private async integrate(
    shellFiles: TerminalOptions["shellFiles"],
  ): Promise<Integration | undefined> {
    try {
      const paths = await shellFiles
      if (!paths) return undefined
      const reports = await listenForReports(
        (report) => this.queueReport(report),
        (call) => this.present(call),
      )
      if (!this.stopping) return { paths, reports }
      await reports.close()
    } catch (error) {
      console.error("NovaDeck shell integration is unavailable:", error)
    }
    return undefined
  }

  /**
   * Starts a terminal. With `restore`, it continues the saved terminal of that id: in its
   * last directory, with its saved agent sessions, and its transcript shown first unless
   * the shell resumes the session `resume` last reported there (see `claim`).
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
    try {
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
      const resume =
        input.resume &&
        this.resumable(input.id, input.resume, saved?.agents[input.resume]?.sessionId, connected)
      const started = this.spawn(shell, cwd, input, integration, resume?.argv)
      if (resume && started.resumes) {
        this.claims.set(resume.key, input.id)
        started.resumeClaim = resume.key
      }
      const record: Record = {
        summary: {
          id: input.id,
          sessionId: input.sessionId,
          cwd,
          cols: input.cols,
          rows: input.rows,
          exit: null,
          process: shellProcess(shell),
          run: 1,
          agent: null,
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
        activity: null,
        telemetry: null,
        watching: null,
        transcript: null,
        sourceReaders: new Set(),
        promptedAt: saved?.promptedAt ?? null,
        shown: new Map(),
        changed: false,
        savedAt: 0,
        submitted: started.resumes,
      }
      this.records.set(record.summary.id, record)
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

  list(sessionId?: string): TerminalSummary[] {
    return [...this.records.values()]
      .filter((record) => sessionId === undefined || record.summary.sessionId === sessionId)
      .map((record) => ({ ...record.summary }))
  }

  get(terminalId: string): TerminalSummary {
    return { ...this.record(terminalId).summary }
  }

  write(input: { terminalId: string; data: string }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    // Typing before the shell resumes its agent cancels the resume, so the shell gets
    // what was typed; the terminal's own replies, such as focus reports, are not typing.
    if (!terminalReply.test(input.data)) {
      // A cancelled resume leaves its session free for another terminal.
      const claim = record.resumeClaim
      if (this.cancelResume(record) && claim && this.claims.get(claim) === record.summary.id)
        this.claims.delete(claim)
      if (/[\r\n]/.test(input.data)) record.submitted = true
    }
    // node-pty accepts each write synchronously; no input is retried after an uncertain delivery.
    record.process.write(input.data)
  }

  resize(input: { terminalId: string; cols: number; rows: number }, ownerId: string): void {
    const record = this.control(input.terminalId, ownerId)
    this.running(record)
    record.process.resize(input.cols, input.rows)
    void this.enqueue(record, () => {
      record.screen.resize(input.cols, input.rows)
      record.summary = { ...record.summary, cols: input.cols, rows: input.rows }
      this.announce(record)
      this.emit(record, { type: "resized", cols: input.cols, rows: input.rows })
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
        if (this.records.get(input.terminalId) !== record)
          throw new DomainError("TERMINAL_NOT_FOUND")
        const resume =
          input.resume &&
          this.resumable(
            record.summary.id,
            input.resume,
            record.agents[input.resume]?.sessionId,
            connected,
          )
        const started = this.spawn(shell, cwd, input, integration, resume?.argv)
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
            activity: null,
            telemetry: null,
          } satisfies TerminalSummary,
          foreground: undefined,
          binding: null,
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
        })
        // The earlier shell's screen shows above the new one's.
        if (earlier) this.show(record, earlier, null)
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
      // A terminal from an earlier runner is closed by forgetting what restores it.
      this.forget(input.terminalId)
      throw new DomainError("TERMINAL_NOT_FOUND")
    }
    if (record.controller !== undefined && record.controller !== ownerId)
      throw new DomainError("CONTROL_IN_USE")
    await this.terminate(record)
    this.remove(record)
    this.forget(input.terminalId)
  }

  /** Forgets what restores the terminal, and the sessions it claimed. */
  private forget(terminalId: string): void {
    for (const [key, claimant] of this.claims) if (claimant === terminalId) this.claims.delete(key)
    this.persisting(() => this.options.records?.removeTerminal(terminalId))
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
        record.summary = { ...record.summary, agent: null, activity: null, telemetry: null }
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
    const watcher = new Watcher(this.list())
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
   * What the terminal's agents showed the person: a snapshot, then another on each
   * change, until the terminal is gone or `signal` aborts.
   */
  async *shown(terminalId: string, signal?: AbortSignal): AsyncGenerator<AgentShown> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.record(terminalId)
    yield* this.snapshots(this.showings, terminalId, this.shownOf(record), signal)
  }

  /** One thing the terminal's agents showed, as captured; NOT_FOUND once it is not shown. */
  artifact(terminalId: string, artifact: string): ArtifactContent {
    const found = this.record(terminalId).shown.get(artifact)
    if (!found) throw new DomainError("NOT_FOUND")
    return found.content
  }

  /**
   * Shows the person what an agent asked to, through NovaDeck's MCP server in one of
   * the terminal's shells: any file they can read, as a viewer would, or a page. It
   * opens at once when the agent says they asked, unless it may hold secrets. A call
   * without the shell's own token learns nothing more.
   */
  async present(call: Call): Promise<PresentAnswer> {
    const record = this.records.get(call.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, call.token)) return unanswered
    const read = readRequest(call.request)
    if (!read.ok) return read
    const { request } = read
    const captured = await capture(request, {
      cwd: record.summary.cwd,
      project: this.projectFolder(record.summary.sessionId),
    })
    if (!captured.ok) return captured
    // Closed, or the runner stopped, while the file was read.
    if (this.stopping || this.records.get(call.terminalId) !== record) return unanswered
    const opened = request.open === true && !captured.held
    record.shown = remember(record.shown, captured, opened)
    const shown = this.shownOf(record)
    for (const reader of this.showings.get(call.terminalId) ?? []) reader.push(shown)
    return {
      ok: true,
      id: captured.id,
      kind: captured.content.kind,
      name: captured.name,
      opened,
      ...(captured.held && { held: true }),
    }
  }

  /** The folder of the session's project; undefined when that cannot be told. */
  private projectFolder(sessionId: string): string | undefined {
    try {
      return this.options.projectFolder?.(sessionId)
    } catch {
      return undefined
    }
  }

  private shownOf(record: Record): AgentShown {
    return {
      terminalId: record.summary.id,
      shown: [...record.shown.values()].map((artifact) => artifact.shown),
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
   * transcript NovaDeck reads, is NOT_FOUND.
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

  /**
   * A plan the bound session keeps as an actor's latest: its text as it stands, then
   * again on each change, until another plan replaces it, the terminal's agent leaves
   * the session, or `signal` aborts. A plan it does not keep is NOT_FOUND.
   */
  async *plan(terminalId: string, plan: string, signal?: AbortSignal): AsyncGenerator<PlanContent> {
    if (this.stopping) throw new DomainError("RUNTIME_CLOSING")
    const record = this.record(terminalId)
    const { binding } = record
    if (!binding || !planOf(binding, record.activity, plan)) throw new DomainError("NOT_FOUND")
    const reader = new AbortController()
    record.sourceReaders.add(reader)
    const abort = () => reader.abort()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) reader.abort()
    try {
      let stamp: string | undefined
      let sent = ""
      while (!reader.signal.aborted && record.binding === binding) {
        const current = planOf(binding, record.activity, plan)
        if (!current) return
        // eslint-disable-next-line no-await-in-loop -- Each look follows the one before.
        const now = await planStamp(current.source)
        if (now !== undefined && now !== stamp) {
          // eslint-disable-next-line no-await-in-loop -- As above.
          const content = await planContent(plan, current.source)
          // A read that failed is tried again on the next look.
          if (content) stamp = now
          const key = JSON.stringify(content)
          if (content && key !== sent && !reader.signal.aborted) {
            sent = key
            yield content
          }
        }
        // eslint-disable-next-line no-await-in-loop -- As above.
        await sleep(this.options.planPollMs, undefined, { signal: reader.signal }).catch(() => {})
      }
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
    for (const streams of [this.details, this.showings])
      for (const readers of streams.values()) for (const reader of readers) reader.finish()
    for (const record of this.records.values()) this.unwatch(record)
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
    return agentDetail(record.summary.id, record.binding, record.activity, record.telemetry)
  }

  /** Tells the terminal's detail readers of a change; each drops one it already has. */
  private detailed(record: Record): void {
    const readers = this.details.get(record.summary.id)
    if (!readers) return
    const detail = this.detailOf(record)
    for (const reader of readers) reader.push(detail)
  }

  /** Ends the terminal's detail and shown streams, as it is closed. */
  private undetail(id: string): void {
    for (const streams of [this.details, this.showings]) {
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
      record.summary = { ...record.summary, process: current }
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
   * launcher and the endpoint and token its connected agents report with. A `resume`
   * command runs as the integration starts; configured shell arguments leave it out.
   */
  private spawn(
    shell: string,
    cwd: string,
    input: Size & { id?: string; terminalId?: string },
    integration: (Integration & { shims: readonly AgentName[] }) | undefined,
    resume?: readonly string[],
  ): Started {
    const { cols, rows } = input
    const id = input.id ?? input.terminalId ?? ""
    const token = randomBytes(24).toString("hex")
    const launch = (withResume: boolean): ShellLaunch =>
      integration
        ? shellLaunch(shell, integration.paths, this.options.env, {
            shims: integration.shims,
            ...(withResume &&
              resume &&
              this.options.shellArgs === undefined && {
                resume: { argv: resume, file: join(integration.paths.resume, randomUUID()) },
              }),
          })
        : { args: [], env: this.options.env, integrated: false, resumes: false }
    let launched = launch(true)
    // The shell reads the command from a file only it and the runner can read.
    if (launched.resumeFile)
      try {
        writeFileSync(launched.resumeFile, resume!.join(" "), { mode: 0o600, flag: "wx" })
      } catch {
        launched = launch(false)
      }
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
    try {
      const child = pty.spawn(shell, [...(this.options.shellArgs ?? launched.args)], {
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
      // node-pty can report an exit before it learns the code, e.g. after ending a
      // Windows terminal whose input failed.
      child.onExit(({ exitCode, signal }) =>
        this.exit(record, { code: signal ? null : (exitCode ?? null), signal: signalName(signal) }),
      ),
      // Device-status queries are answered by the runner's screen, even with no viewer.
      screen.onData((data) => {
        if (!record.exitQueued) child.write(data)
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
    this.cancelResume(record)
    record.changed = true
    const moved = cwd !== record.summary.cwd
    record.binding = null
    record.activity = null
    record.telemetry = null
    this.unwatch(record)
    if (moved || record.summary.agent !== null) {
      record.summary = { ...record.summary, cwd, agent: null, activity: null, telemetry: null }
      this.announce(record)
    }
    if (moved) this.save(record, false)
  }

  /**
   * Handles reports one at a time, in the order they arrived, as a report may wait for
   * the platform to tell who holds the foreground.
   */
  private queueReport(report: Report): void {
    this.reports = this.reports
      .then(() => this.report(report))
      .catch((error: unknown) => console.error("NovaDeck could not take an agent report:", error))
  }

  /**
   * A harness hook reported; its harness decodes it, and `observe` decides whether each
   * session it names is this terminal's own and the latest, and what it changes.
   */
  private async report(report: Report): Promise<void> {
    const record = this.records.get(report.terminalId)
    if (!record || record.exitQueued || !sameToken(record.token, report.token)) return
    const events = harnesses[report.agent].decode(report)
    if (events.length === 0) return
    const { process: child } = record
    const disconnections = this.disconnections.get(report.agent)
    const [foreground, connected] = await Promise.all([
      shellInForeground(child.pid),
      this.connected(report.agent),
    ])
    if (record.process !== child || record.exitQueued) return
    // A disconnection while this waited forgot what the report would bring back.
    if (this.disconnections.get(report.agent) !== disconnections) return
    // The bound agent process may have exited without the shell showing a prompt, as in
    // tmux or a nested shell: its binding ended with it, and a later process may bind.
    let changed = false
    if (record.binding?.instance && !alive(record.binding.instance)) {
      record.binding = null
      record.activity = null
      record.telemetry = null
      this.unwatch(record)
      if (record.summary.agent !== null) {
        record.summary = { ...record.summary, agent: null, activity: null, telemetry: null }
        this.announce(record)
      }
    }
    const facts = {
      promptedAt: record.promptedAt,
      shellInForeground: foreground,
      submitted: record.submitted,
      connected,
      platform: process.platform,
    }
    const cwd = record.summary.cwd
    for (const event of events) {
      if (event.type !== "session-observed") {
        this.applyFact(record, event)
        continue
      }
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
      changed = true
      // A newly bound session waits for its first prompt; one still bound keeps its activity.
      const same =
        before !== null &&
        next.binding !== null &&
        before.agent === next.binding.agent &&
        before.sessionId === next.binding.sessionId
      if (!same) {
        record.activity = next.binding ? fresh(event.startedAt) : null
        record.telemetry = null
        this.follow(record, event)
      }
      record.summary = { ...record.summary, cwd: next.cwd }
    }
    this.publishAgent(record, record.summary.cwd !== cwd)
    if (changed) this.save(record, false)
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
      if (this.applyFact(record, fact)) this.publishAgent(record, false)
    }).catch((error: unknown) => console.error("NovaDeck stopped following an agent:", error))
  }

  /** Applies what the bound session's hooks or records said; true when it changed. */
  private applyFact(record: Record, fact: Exclude<HarnessEvent, SessionObserved>): boolean {
    if (!record.binding) return false
    if (fact.type === "telemetry-observed") {
      const next = observeTelemetry(record.telemetry, record.binding, fact)
      if (next) record.telemetry = next
      return next !== undefined
    }
    const next = record.activity && apply(record.activity, record.binding, fact)
    if (next) record.activity = next
    return Boolean(next)
  }

  private unwatch(record: Record): void {
    record.watching?.abort()
    record.watching = null
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
    const agent = record.binding?.agent ?? null
    const activity = record.binding && record.activity ? activitySummary(record.activity) : null
    const telemetry = record.binding && record.telemetry ? telemetrySummary(record.telemetry) : null
    const { summary } = record
    if (
      !moved &&
      summary.agent === agent &&
      JSON.stringify(summary.activity) === JSON.stringify(activity) &&
      JSON.stringify(summary.telemetry) === JSON.stringify(telemetry)
    )
      return
    record.summary = { ...summary, agent, activity, telemetry }
    this.announce(record)
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
   * saved once the runner is stopping.
   */
  private save(record: Record, transcript: boolean): void {
    // A failed save leaves the screen marked changed, so a later one tries again, once
    // `saveMs` has passed.
    if (transcript) record.savedAt = performance.now()
    const saved = this.persisting(() =>
      this.options.records?.saveTerminal({
        id: record.summary.id,
        sessionId: record.summary.sessionId,
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
      console.error("NovaDeck could not save a terminal:", error)
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
      record.activity = null
      record.telemetry = null
      this.unwatch(record)
      record.summary = {
        ...record.summary,
        exit,
        process: null,
        agent: null,
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
      await this.hangUp(record.process)
      try {
        record.process.kill()
      } catch {
        this.exit(record, { code: null, signal: null })
      }
      timer = setTimeout(() => {
        try {
          record.process.kill("SIGKILL")
        } catch {
          this.exit(record, { code: null, signal: null })
        }
      }, 1000)
      await record.exited
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Hangs up the program in the terminal's foreground, as closing a real terminal does.
   * A shell passes its own hangup on to the jobs it started, but not always: bash does
   * not to a command its prompt hook ran, as a resumed agent is, and would leave it
   * running without a terminal, still holding its session.
   */
  private async hangUp(child: pty.IPty): Promise<void> {
    const group = await terminalForeground(child.pid)
    if (group === undefined || group === child.pid) return
    try {
      process.kill(-group, "SIGHUP")
    } catch {
      // Gone meanwhile.
    }
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
      for (const watcher of this.watchers.keys()) watcher.removed(record.summary)
      this.undetail(record.summary.id)
    }
  }

  /** Forgets an exited terminal; its screen lasts until its viewers finish reading. */
  private remove(record: Record): void {
    const id = record.summary.id
    if (this.records.get(id) !== record) return
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
