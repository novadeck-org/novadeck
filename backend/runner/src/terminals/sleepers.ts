import { existsSync } from "node:fs"

import {
  agentSessionId,
  isAgentName,
  type AgentName,
  type TerminalSummary,
} from "@novadeck/protocol"

import { harnesses } from "../harnesses/registry.js"
import { logs } from "../log.js"
import type { Inbox } from "../messaging/inbox.js"
import { agentLabel } from "../messaging/messages.js"
import type { Messaging } from "../messaging/messaging.js"
import { standingDone } from "../messaging/peers.js"
import type { PeerRecord } from "./peers-host.js"
import type { Record } from "./record.js"
import { wakeMs, wakeRefusal, type Claims } from "./resumes.js"
import type { ListedTerminal } from "./saved-terminals.js"
import type { Saves } from "./saving.js"
import { savedSummaryOf, type AgentSummary } from "./summary.js"

const log = logs.for("terminals")

/**
 * How long the person's keys are dropped while a woken shell has not yet read its resume
 * command, in milliseconds: a slow rc file can't lock the terminal for longer.
 */
export const keysHeldMs = 10_000

/**
 * How long a wake waits for a client to create the terminal before the runner does it
 * itself, in milliseconds: with no window open, as on macOS after the last one closed, or
 * for a client that first sees the terminal already waking.
 */
export const graceMs = 3_000

/**
 * The same wait while a client watches, in milliseconds: its own `create`s come a few at a
 * time (the adapter's start throttle), so the runner waits for the last of a crowd.
 */
export const watchedGraceMs = 10_000

/** How many creates of its own the runner has under way at once, and the gap between starts. */
export const aloneLimit = 3
export const aloneGapMs = 150

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref()
  })

export type SleepersHost = {
  readonly messaging: () => Messaging
  readonly saves: () => Saves
  readonly inbox: () => Inbox
  readonly claims: () => Claims
  /** Whether Novadeck is connected to the harness, whose sessions it may resume. */
  readonly connected: (agent: AgentName) => Promise<boolean>
  /** Whether shells here can run a resume command: with the integration, and no custom arguments. */
  readonly resumes: () => boolean
  /** The project a session belongs to; undefined when the session is gone. */
  readonly projectOf: (sessionId: string) => string | undefined
  /** The runner holds a record of the terminal, running or exited. */
  readonly held: (terminalId: string) => boolean
  /** The terminal was closed in this runner's lifetime. */
  readonly closed: (terminalId: string) => boolean
  /** The terminal's record, if the runner holds one. */
  readonly record: (terminalId: string) => Record | undefined
  readonly stopping: () => boolean
  /** Whether any client watches the terminals. */
  readonly watched: () => boolean
  /** Starts the terminal's shell resuming its agent, as a client's restore does. */
  readonly create: (row: ListedTerminal, agent: AgentName) => Promise<unknown>
  /** Tells every watcher of a terminal kept only as saved. */
  readonly changed: (row: ListedTerminal) => void
  /** The terminal is not a sleeper any more and was not started: its message watchers end. */
  readonly ended: (terminalId: string) => void
}

/**
 * The agent a saved terminal's last program was: its name, or for `node` (an npm-installed
 * Codex, which older rows kept as the process name) the one agent that reported a session.
 */
const programAgent = (
  row: Pick<ListedTerminal, "lastProgram" | "agents">,
): AgentName | undefined => {
  const program = row.lastProgram
  if (isAgentName(program)) return program
  if (program !== "node" && program !== "nodejs") return undefined
  const only = Object.keys(row.agents).filter(isAgentName)
  return only.length === 1 ? only[0] : undefined
}

/** A sleeper as the agent layer reads a terminal: its saved row, shaped as a record's half. */
export type Sleeper = PeerRecord & { readonly summary: AgentSummary }

/**
 * Terminals whose agents sleep: saved, no process, their session resting in messaging
 * (`Messaging.rest`) until someone needs them. Messaging holds who rests where; this holds
 * which of them are being woken, and what a wake asks of the terminal it starts.
 */
export class Sleepers {
  /** The terminals whose wake is wanted: their `create` is expected, so they are not asleep. */
  private readonly wakes = new Set<string>()
  /** Wakes being judged, so each is asked once; settles with why it was refused, if it was. */
  private readonly judging = new Map<string, Promise<string | undefined>>()
  /** The grace of each wake that waits for a client's `create`: one timer for each terminal. */
  private readonly timers = new Map<string, NodeJS.Timeout>()
  /** The terminals a `create` is under way for, a wake's or a restore's, so none is doubled. */
  private readonly creating = new Set<string>()
  /** The session of each terminal rested here, to find its row. */
  private readonly sessions = new Map<string, string>()
  /** The runner's own creates under way, and those waiting for a place among them. */
  private starting = 0
  private readonly queued: (() => void)[] = []
  private gate: Promise<void> = Promise.resolve()

  constructor(private readonly host: SleepersHost) {}

  /**
   * Rests every saved terminal whose agent can resume, and starts the wakes already owed:
   * a turn the stop cut short, and messages waiting for a session. Before any client lists.
   */
  start(): void {
    const { messaging } = this.host
    const turns: string[] = []
    for (const row of this.host.saves().terminals()) {
      const resting = this.rest(row)
      if (resting && row.agents[resting.agent]?.turn !== undefined) turns.push(row.id)
    }
    for (const id of turns) this.ask(id)
    for (const id of messaging().wakesWanted()) this.ask(id)
  }

  /**
   * Rests the terminal's saved row if its agent can resume there: the program last in its
   * foreground is an agent whose session it reported, and a shell here can run the resume.
   * Not one whose record the runner holds, nor a closed one.
   */
  rest(row: ListedTerminal): { agent: AgentName; sessionId: string } | undefined {
    const { id } = row
    if (!this.host.resumes() || this.host.held(id) || this.host.closed(id)) return undefined
    const agent = programAgent(row)
    if (!agent || !harnesses[agent].launch.resume) return undefined
    const sessionId = row.agents[agent]?.sessionId
    if (sessionId === undefined || !agentSessionId.safeParse(sessionId).success) return undefined
    const projectId = this.host.projectOf(row.sessionId)
    if (projectId === undefined) return undefined
    const resting = { agent, sessionId }
    this.sessions.set(id, row.sessionId)
    this.host
      .messaging()
      .rest(id, { projectId, sessionId: row.sessionId }, row.handle, row.ledBy, resting)
    return resting
  }

  /** The shell integration did not come up: no shell can run a resume, so none rests. */
  integrationFailed(): void {
    for (const id of Array.from(this.sessions.keys())) {
      if (this.host.held(id)) continue
      const session = this.sessions.get(id)
      this.host
        .messaging()
        .unregister(
          id,
          false,
          "Novadeck's shell integration did not start, so nothing there can be woken.",
        )
      this.forget(id)
      this.host.ended(id)
      const row = this.row(id, session)
      if (row) this.host.changed(row)
    }
  }

  /**
   * `agent` is disconnected and `forgetRows` makes the saved rows forget its sessions:
   * the terminals that slept on one rest no more, and watchers hear of each.
   */
  forgetAgent(agent: AgentName, forgetRows: () => void): void {
    const ids = [...this.sessions.keys()].filter(
      (id) => !this.host.held(id) && this.host.messaging().resting(id)?.agent === agent,
    )
    const sessions = new Map(ids.map((id) => [id, this.sessions.get(id)]))
    for (const id of ids) {
      this.host
        .messaging()
        .unregister(
          id,
          false,
          `Novadeck was disconnected from ${agentLabel(agent)}, so it can't be woken.`,
        )
      this.forget(id)
      this.host.ended(id)
    }
    forgetRows()
    for (const [id, session] of sessions) {
      const row = this.row(id, session)
      if (row) this.host.changed(row)
    }
  }

  /** What rests on the terminal's session with no record to run it; undefined for any other. */
  resting(terminalId: string): { agent: AgentName; sessionId: string } | undefined {
    if (this.host.held(terminalId)) return undefined
    return this.host.messaging().resting(terminalId)
  }

  /** Whether the terminal's agent sleeps: resting with no record, not being woken. */
  asleep(terminalId: string): boolean {
    return this.resting(terminalId) !== undefined && !this.wakes.has(terminalId)
  }

  /**
   * Asks for the terminal's wake: its summary stops saying it sleeps, and a client that
   * lists it creates it. A wake that carries messages is judged first, as its `create`
   * would be: not ok, the messages are gone and the terminal stays asleep. Once for each
   * wake. Whether it is being woken: true also for one already asked.
   */
  ask(terminalId: string): boolean {
    if (this.wakes.has(terminalId) || this.judging.has(terminalId)) return true
    const resting = this.resting(terminalId)
    if (!resting || this.host.stopping()) return false
    const judged = this.judge(terminalId, resting).finally(() => {
      if (this.judging.get(terminalId) === judged) this.judging.delete(terminalId)
    })
    this.judging.set(terminalId, judged)
    return true
  }

  /**
   * Asks the wake and waits for its judgment: `waking`, or `why` it can't be woken (the
   * terminal stays asleep); undefined for a terminal that is no sleeper.
   */
  async verdict(
    terminalId: string,
  ): Promise<{ readonly waking: true } | { readonly why: string } | undefined> {
    if (!this.ask(terminalId)) return undefined
    const why = await this.judging.get(terminalId)
    if (why !== undefined) return { why }
    return this.wakes.has(terminalId) ? { waking: true } : undefined
  }

  /** Judges a wake: why it is refused, or undefined when it is under way or no longer wanted. */
  private async judge(
    terminalId: string,
    resting: { agent: AgentName; sessionId: string },
  ): Promise<string | undefined> {
    const { agent, sessionId } = resting
    const connected = await this.host.connected(agent).catch(() => false)
    // Gone, woken by another path, or resting on another session meanwhile.
    const now = this.resting(terminalId)
    if (this.host.stopping() || now?.agent !== agent || now.sessionId !== sessionId) return
    const check = this.host.claims().check(terminalId, agent, sessionId, connected)
    if (check.ok) return void this.wake(terminalId)
    const why = wakeRefusal(agent, check.reason)
    this.host.messaging().wakeFailed(terminalId, why)
    return why
  }

  private wake(terminalId: string): void {
    this.wakes.add(terminalId)
    this.publish(terminalId)
    this.arm(terminalId)
  }

  /**
   * The runner creates the terminal itself after a short grace unless a client's `create`
   * came, watched or not: a window may be closed (macOS keeps the app up), or first list the
   * terminal as waking. One timer for each terminal.
   */
  private arm(terminalId: string): void {
    if (this.timers.has(terminalId)) return
    const timer = setTimeout(() => {
      this.timers.delete(terminalId)
      void this.alone(terminalId)
    }, this.host.watched() ? watchedGraceMs : graceMs)
    timer.unref()
    this.timers.set(terminalId, timer)
  }

  private disarm(terminalId: string): void {
    clearTimeout(this.timers.get(terminalId))
    this.timers.delete(terminalId)
  }

  /**
   * A `create` of the terminal is under way; the runner starts none of its own meanwhile.
   * Returns its end, which arms the grace again should the wake still be wanted.
   */
  creates(terminalId: string): () => void {
    this.creating.add(terminalId)
    return () => {
      this.creating.delete(terminalId)
      if (this.wakes.has(terminalId)) this.arm(terminalId)
    }
  }

  /**
   * The runner's own creates go a few at a time with a gap between, as the adapter's
   * do: a crowd of wakes would otherwise start every shell at once.
   */
  private async alone(terminalId: string): Promise<void> {
    if (this.starting < aloneLimit) this.starting += 1
    else await new Promise<void>((resolve) => this.queued.push(resolve))
    try {
      const turn = this.gate
      this.gate = turn.then(() => pause(aloneGapMs))
      await turn
      await this.createAlone(terminalId)
    } finally {
      const next = this.queued.shift()
      if (next) next()
      else this.starting -= 1
    }
  }

  private async createAlone(terminalId: string): Promise<void> {
    const resting = this.resting(terminalId)
    if (
      !this.wakes.has(terminalId) ||
      this.creating.has(terminalId) ||
      this.host.stopping() ||
      !resting
    )
      return
    const row = this.row(terminalId, this.sessions.get(terminalId))
    if (!row) return
    // An unattended create that fails is reported by `create` itself (see `failedStart`).
    await this.host.create(row, resting.agent).catch(() => undefined)
  }

  /**
   * A `create` of the terminal failed before any shell: the wake is over and its messages
   * are gone, as the terminal stays asleep as it was.
   */
  failedStart(terminalId: string, why: string): void {
    const woke = this.wakes.delete(terminalId)
    this.judging.delete(terminalId)
    this.disarm(terminalId)
    if (!woke && !this.resting(terminalId)) return
    this.host.messaging().wakeFailed(terminalId, why)
    this.publish(terminalId)
  }

  /** Tells watchers the terminal's summary as its row and resting state say it now. */
  publish(terminalId: string): void {
    const row = this.row(terminalId, this.sessions.get(terminalId))
    if (row) this.host.changed(row)
  }

  /** The terminal is not a sleeper any more, or was started: its wake, if any, is over. */
  forget(terminalId: string): void {
    this.wakes.delete(terminalId)
    this.judging.delete(terminalId)
    this.disarm(terminalId)
    this.sessions.delete(terminalId)
  }

  /** A saved terminal's summary: with its agent's sleep, wake and standing report. */
  summaryOf(row: ListedTerminal, delivered = this.deliveries()): TerminalSummary {
    const resting = this.resting(row.id)
    if (!resting) return savedSummaryOf(row)
    return savedSummaryOf(row, {
      agent: resting.agent,
      waking: this.wakes.has(row.id),
      reported: this.reported(row, delivered),
    })
  }

  /**
   * When each terminal was last delivered a message, read from the messages only when a
   * sleeper has a done mark to judge, and once for everything one listing shows.
   */
  deliveries(): () => ReadonlyMap<string, number> {
    let all: ReadonlyMap<string, number> | undefined
    return () => (all ??= this.host.messaging().deliveredAt())
  }

  /** The agent's standing `done`, as a terminal that runs shows it (`standingDone`). */
  private reported(
    row: ListedTerminal,
    delivered: () => ReadonlyMap<string, number>,
  ): TerminalSummary["reported"] {
    const reports = this.host.inbox().reports(row.id)
    if (!reports.done) return null
    const done = standingDone(reports, row.work?.personAt, delivered().get(row.id) ?? null)
    return done && { subject: done.subject, at: done.at }
  }

  /** The saved row of a terminal known by its session. */
  private row(terminalId: string, sessionId: string | undefined): ListedTerminal | undefined {
    return this.host
      .saves()
      .terminals(sessionId)
      .find(({ id }) => id === terminalId)
  }

  /** The person ended a sleeper's lead: kept in its row, told to messaging and to watchers. */
  endLead(terminalId: string): void {
    this.host.saves().endLead(terminalId)
    this.host.messaging().endLead(terminalId)
    this.publish(terminalId)
  }

  /** The sleeper as the agent layer reads a terminal; undefined for any other. */
  peer(terminalId: string): Sleeper | undefined {
    const row = this.resting(terminalId) && this.row(terminalId, this.sessions.get(terminalId))
    return row ? this.peerOf(row) : undefined
  }

  /** The sleepers of a session. */
  sleepersOf(sessionId: string): readonly Sleeper[] {
    const delivered = this.deliveries()
    return this.host
      .saves()
      .terminals(sessionId)
      .filter(({ id }) => this.resting(id) !== undefined)
      .map((row) => this.peerOf(row, delivered))
  }

  private peerOf(row: ListedTerminal, delivered = this.deliveries()): Sleeper {
    const {
      cols: _cols,
      rows: _rows,
      exit: _exit,
      run: _run,
      ...summary
    } = this.summaryOf(row, delivered)
    return { summary, naming: row.naming, work: row.work, openedBy: row.openedBy, bound: null }
  }

  /**
   * A `create` started the terminal's shell: its wake is over, whether it resumes the
   * agent (`agent`, the one resumed) or starts a plain shell, which keeps the row's lead
   * and says why on its screen. A woken shell is `woken` until the agent shows, and a wake that carries messages
   * gives up after `wakeMs` without it.
   */
  started(record: Record, agent: AgentName | undefined, why: string): void {
    const { id } = record.summary
    const { messaging } = this.host
    this.wakes.delete(id)
    this.judging.delete(id)
    this.disarm(id)
    if (!messaging().resting(id)) return
    // Woken whatever came of it: the row keeps its program and its lead, the person looking.
    record.woken = Date.now()
    // A seen wake that judged not ok is a plain shell: nothing waits for an agent there.
    if (agent === undefined) return messaging().wakeEnded(id, why)
    if (!messaging().wakeWanted(id)) return
    const timer = setTimeout(() => this.timedOut(record, agent), wakeMs)
    timer.unref()
  }

  private timedOut(record: Record, agent: AgentName): void {
    const { id } = record.summary
    const { messaging } = this.host
    if (this.host.stopping() || this.host.record(id) !== record) return
    // A bound session ends its rest, and its own prompt showing counts as the agent up.
    if (messaging().resting(id) === undefined || messaging().shownAgent(id) !== undefined) return
    log.warn("terminals.wake-timeout", "A woken agent did not start in time", { data: { id } })
    messaging().wakeEnded(id, wakeRefusal(agent, "timeout"))
  }

  /**
   * The woken shell's prompt came back with no session bound: the agent failed (an expired
   * login, a crash). The row stays resumable and the shell shows why; the messages that
   * woke it are gone.
   */
  failed(record: Record, why: string): void {
    const { id } = record.summary
    this.host.messaging().wakeEnded(id, why)
  }

  /**
   * Whether the woken shell has yet to read its resume command and drops the person's
   * keys meanwhile, which would take the command's place at the prompt: for `keysHeldMs`.
   */
  holdsKeys(record: Pick<Record, "woken" | "resumeFile">): boolean {
    const { woken, resumeFile } = record
    if (woken === undefined || Date.now() - woken >= keysHeldMs) return false
    // The command goes as an argument where no file is read (Windows cmd): no prompt takes
    // a key's place, so none is held.
    return resumeFile !== undefined && existsSync(resumeFile)
  }
}
