import { stat } from "node:fs/promises"

import type { ConversationScan } from "@novadeck/harness-core/conversation"
import type { Install } from "@novadeck/harness-core/harness"
import {
  historyLimits,
  isAgentName,
  type AgentName,
  type ClosedTerminal,
  type ClosedTerminalState,
  type HistoryChange,
  type TerminalSummary,
} from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

import { DomainError } from "../errors.js"
import { harnesses } from "../harnesses/registry.js"
import { logs } from "../log.js"
import { agentLabel } from "../messaging/messages.js"
import type { ClosedRecord, ClosedRecords, ListedClosed } from "../workspaces/closed.js"
import { mention } from "./handles.js"
import type { Record } from "./record.js"
import { resumeNote } from "./resumes.js"
import {
  hasRun,
  type AgentReport,
  type SavedTerminal,
  type TerminalIdentity,
} from "./saved-terminals.js"
import { summaryTitle } from "./titles.js"

const log = logs.for("history")

/** A closed terminal is kept this long, in milliseconds. */
const retentionMs = 30 * 24 * 60 * 60 * 1000

/** What History needs of the store: closed rows, and keeping a handle in a session. */
export type HistoryRecords = ClosedRecords & {
  /** Records that the session gave the handle, unless it gave it already; whether it did now. */
  adoptHandle(sessionId: string, handle: string): boolean
}

/** A running terminal, by the handle the person sees and the id that is unique. */
type OpenTerminal = { readonly handle: string; readonly terminalId: string }

/** How long History waits, in milliseconds; tests shorten it. */
export type HistoryTimes = {
  /** How long a restore may wait to be confirmed, as held at a dialog, before its row is ready again. */
  readonly restoreMs: number
  /** How often rows older than 30 days are deleted. */
  readonly pruneMs: number
  /** The longest one availability check is waited for; an unanswered one reads as unknown. */
  readonly checkMs: number
  /** How long after its prompt shows an unbound resume is looked at again: just over Antigravity's grace. */
  readonly graceMs: number
}

const defaults: HistoryTimes = {
  restoreMs: 60_000,
  pruneMs: 60 * 60 * 1000,
  checkMs: 3_000,
  graceMs: 3_200,
}

/** What one pass through a list reads once: each agent's conversation scan and whether it is connected. */
type Pass = {
  readonly scans: Map<AgentName, ConversationScan>
  readonly connected: Map<AgentName, Promise<boolean>>
}

const newPass = (): Pass => ({ scans: new Map(), connected: new Map() })

/** What `judge` follows of a terminal's turns under its bound session. */
type Turns = { session: string | undefined; working: boolean; ended: number; run: number }

/** How many availability checks run at once, so a long list on a slow disk never stalls the runner. */
const checksAtOnce = 8

/** A terminal the runner holds, which History reads as it closes and writes its restore to. */
export type Closing = Record

/** What the runner lets History ask of it. */
export type HistoryHost = {
  readonly records: HistoryRecords | undefined
  /** Every project's id. */
  readonly projects: () => readonly string[]
  readonly projectOf: (sessionId: string) => string
  /** Whether the session's project is being removed: nothing of it is kept. */
  readonly going: (sessionId: string) => boolean
  readonly stopping: () => boolean
  readonly install: (agent: AgentName) => Promise<Install | undefined>
  readonly connected: (agent: AgentName) => Promise<boolean>
  /** The terminal holding or claiming the agent's session, if one does. */
  readonly holder: (agent: AgentName, sessionId: string) => OpenTerminal | undefined
  /** Each terminal of a session, running or kept, with the handle it leads under. */
  readonly terminalsIn: (
    sessionId: string,
  ) => readonly { readonly handle: string; readonly ledBy: string | null }[]
  /** A handle the session has never given. */
  readonly drawHandle: (sessionId: string) => string
  /** Gives back the sessions the terminal claimed. */
  readonly releaseClaim: (terminalId: string) => void
  /** Keeps the terminal's screen for a row (see `Saves.archive`); `settled` runs when that is done or given up. */
  readonly archive: (record: Closing, write: (sealed: string) => void, settled: () => void) => void
  /** Calls `done` once the terminal's own screen is saved, as its transcript (see `Saves.afterSaved`). */
  readonly saved: (record: Closing, done: () => void) => void
  /** The running terminal restored from the row, if one is. */
  readonly restoredBeside: (row: string) => OpenTerminal | undefined
  /** The summary of the terminal restored from the row as `terminalId`, if one is running. */
  readonly restoredAs: (terminalId: string, row: string) => TerminalSummary | undefined
  /** The transcript path the running terminal's session reported at bind. */
  readonly transcriptOf: (agent: AgentName, sessionId: string) => string | undefined
  /** Whether a line was ever entered in a terminal kept only as saved. */
  readonly ran: (terminalId: string) => boolean
  /** Tells watchers of the terminal's summary. */
  readonly announce: (record: Closing) => void
  /** Shows the person a line in a terminal. */
  readonly say: (record: Closing, text: string) => void
}

/** What the restored terminal waits on: the conversation it resumes, until it shows it worked. */
export type Restoring = {
  readonly row: string
  readonly projectId: string
  readonly agent: AgentName
  readonly session: string
  readonly timer: NodeJS.Timeout
  /** When its prompt was first seen, for a harness that gives a missing id a grace. */
  readySince?: number
  /** The one look after the grace, when the prompt showed and nothing else had yet. */
  recheck?: NodeJS.Timeout
}

/** What a restore starts from: the row, the terminal it makes, and how it learns the outcome. */
export type Plan = {
  /** What the new terminal is made from, as a saved terminal is. */
  readonly saved: SavedTerminal
  /** The agent whose conversation is resumed; undefined for a plain terminal. */
  readonly resume: AgentName | undefined
  /** Its handle, kept or drawn, and its title layers, decided at the moment of asking. */
  identity(sessionId: string): TerminalIdentity
  /**
   * The terminal's shell started: a plain terminal's row goes once its saved output is on the
   * screen (`opened`), an agent's waits to be confirmed.
   */
  started(record: Closing, resumes: boolean, opened: boolean, shown?: Promise<void>): void
}

type RestoreInput = {
  readonly id: string
  readonly sessionId: string
  readonly closed?: string | undefined
}

const clip = (text: string | null, limit: number): string | null =>
  text === null ? null : text.slice(0, limit)

/** The agent a row resumes: the one with the latest report, whatever program was last seen. */
const resumeOf = (row: Pick<ListedClosed, "agent" | "agents">): AgentName | undefined => {
  if (row.agent === null) return undefined
  let best: AgentName | undefined
  for (const [name, report] of Object.entries(row.agents) as [AgentName, AgentReport][])
    if (isAgentName(name) && (!best || report.seq > (row.agents[best]?.seq ?? -1))) best = name
  return best ?? row.agent
}

/** The agent a woken shell is resuming (its resume claim, `agent:session`), before anything binds. */
const resumingAgent = (record: Pick<Closing, "resumeClaim">): AgentName | undefined => {
  const name = record.resumeClaim?.split(":", 1)[0]
  return isAgentName(name) ? name : undefined
}

/** The agent whose session reported last (the highest `seq`), if any reported. */
const latestAgent = (agents: Closing["agents"]): AgentName | null => {
  let best: AgentName | null = null
  for (const [name, report] of Object.entries(agents) as [AgentName, AgentReport][])
    if (isAgentName(name) && (best === null || report.seq > (agents[best]?.seq ?? -1))) best = name
  return best
}

/** The sessions as a row keeps them: a live turn means nothing to the one who resumes them. */
const withoutTurns = (agents: Record["agents"]): ClosedRecord["agents"] =>
  Object.fromEntries(
    (Object.entries(agents) as [AgentName, AgentReport][]).map(([name, report]) => {
      const { turn: _turn, ...rest } = report
      return [name, rest]
    }),
  )

/** Whether the folder is missing: only ENOENT says so, any other failure is unknown. */
const folderGone = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return false
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
  }
}

const pooled = async <T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> => {
  const out = Array.from<R>({ length: items.length })
  let next = 0
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const index = next
      next += 1
      // eslint-disable-next-line no-await-in-loop -- A lane takes its items one after another.
      out[index] = await work(items[index]!)
    }
  }
  await Promise.all(Array.from({ length: Math.min(checksAtOnce, items.length) }, lane))
  return out
}

/** The terminals closed in the last 30 days: kept at close, listed, restored, and pruned. */
export class ClosedTerminals {
  private readonly times: HistoryTimes
  /** The rows whose restore is under way, by their id. */
  private readonly restoring = new Set<string>()
  /** The plain rows restored, whose removal waits for the new terminal's own saved screen. */
  private readonly pending = new Set<string>()
  /** The plain rows whose screen is not written yet: until it is, they can't be restored. */
  private readonly archiving = new Set<string>()
  /** The turns each running terminal's bound session has had, for judging it restorable. */
  private readonly turns = new WeakMap<Closing, Turns>()
  /** The restores asked for and not yet answered, by the new terminal's id. */
  private readonly inflight = new Map<string, { row: string; done: Promise<TerminalSummary> }>()
  private readonly watchers = new Map<KeyedChanges<string, HistoryChange>, string>()
  /** The changes of watchers still reading the rows they start from. */
  private readonly early = new Set<HistoryChange[]>()
  /** The latest announcement of each row, so a slow check never reports a row after its removal. */
  private readonly latest = new Map<string, number>()
  private counter = 0
  private pruner: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly host: HistoryHost,
    times: Partial<HistoryTimes> = {},
  ) {
    this.times = { ...defaults, ...times }
    if (!host.records) return
    this.prune()
    this.pruner = setInterval(() => this.prune(), this.times.pruneMs)
    this.pruner.unref()
  }

  /** Stops pruning and ends every watch, as the runner shuts down. */
  close(): void {
    clearInterval(this.pruner)
    for (const watcher of this.watchers.keys()) watcher.finish()
  }

  /** Ends the watches an owner holds, as its connection goes. */
  release(ownerId: string): void {
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
  }

  // Close

  /**
   * Keeps a terminal that is closing, before it is marked closed: a row of what restores it,
   * built from the record in memory. Nothing is kept when nothing ever ran in it or its
   * project is going. A failure is logged and never stops the close.
   */
  closing(record: Closing, closedBy: string | null): void {
    try {
      const { records } = this.host
      // A restore that has not been confirmed ends with its terminal: the conversation it
      // bound counts as the restore's success, and anything else leaves its row where it was.
      if (record.restoring) this.observe(record, true)
      if (record.restoring) this.settle(record)
      if (!records || this.host.going(record.summary.sessionId)) return
      // The session that bound, else the one that reported last: an agent that exited with
      // Ctrl-C, or a terminal closed before its session bound, can still be resumed.
      const agent =
        record.bound?.binding.agent ?? resumingAgent(record) ?? latestAgent(record.agents)
      if (!record.ran && !hasRun(record.agents) && agent === null) return
      // A plain shell that stood in for a restore that did not open: the row it came from stands.
      const origin =
        record.restoredFrom === undefined ? undefined : records.closedTerminal(record.restoredFrom)
      // Its row no longer reads as open beside it, once this terminal is closed.
      if (origin) queueMicrotask(() => this.announce(origin))
      if (agent === null && origin && origin.agent !== null) return
      const { summary } = record
      const row: ClosedRecord = {
        id: summary.id,
        projectId: this.host.projectOf(summary.sessionId),
        sessionId: summary.sessionId,
        handle: summary.handle,
        naming: record.naming,
        agent,
        lastProgram: summary.lastProgram,
        command: summary.command,
        cwd: summary.cwd,
        agents: withoutTurns(record.agents),
        interruptions: record.interruptions ?? [],
        transcript: null,
        closedAt: Date.now(),
        closedBy,
      }
      this.insert(row)
      // An agent's row keeps no transcript: its harness has the conversation.
      if (agent === null) {
        // Not restorable until its screen is written, or given up: restored before, it would lose it.
        this.archiving.add(row.id)
        try {
          this.host.archive(
            record,
            (sealed) => {
              this.keep(row.id, sealed)
              // The screen it showed is kept as this row now, so the row it came from can go.
              if (origin && this.pending.delete(origin.id)) this.gone(origin)
            },
            () => {
              if (this.archiving.delete(row.id)) this.announce(row)
            },
          )
        } catch (error) {
          // Nothing will settle it: the row is as restorable as it will be.
          if (this.archiving.delete(row.id)) this.announce(row)
          throw error
        }
      }
    } catch (error) {
      log.error("history.keep-failed", "Novadeck could not keep a closed terminal", { err: error })
    }
  }

  /**
   * The closed terminal's claims on agent sessions are given back, as its shell ended: its
   * row reads as it is now, not as it did while those claims still stood.
   */
  released(terminalId: string): void {
    const row = this.host.records?.closedTerminal(terminalId)
    if (row) this.announce(row)
  }

  /**
   * Keeps a terminal that was only saved, as it closes: its transcript is already sealed.
   * A sleeper passes the agent it rested on, so the row restores that one, not the latest report.
   */
  closingSaved(saved: SavedTerminal, closedBy: string | null, resting?: AgentName): void {
    try {
      const { records } = this.host
      if (!records || this.host.going(saved.sessionId)) return
      const agent = resting ?? latestAgent(saved.agents)
      if (!this.host.ran(saved.id) && !hasRun(saved.agents)) return
      const row: ClosedRecord = {
        id: saved.id,
        projectId: this.host.projectOf(saved.sessionId),
        sessionId: saved.sessionId,
        handle: saved.handle,
        naming: saved.naming,
        agent,
        lastProgram: saved.lastProgram,
        command: saved.command,
        cwd: saved.cwd,
        agents: withoutTurns(saved.agents),
        interruptions: saved.interruptions,
        transcript: agent === null ? saved.transcript : null,
        closedAt: Date.now(),
        closedBy,
      }
      this.insert(row)
    } catch (error) {
      log.error("history.keep-failed", "Novadeck could not keep a closed terminal", { err: error })
    }
  }

  /**
   * Writes a row and tells watchers. One conversation has one row: an older row of the same
   * agent session, as a restore that was never confirmed leaves beside its terminal, goes.
   */
  private insert(row: ClosedRecord): void {
    const records = this.host.records!
    const session = row.agent === null ? undefined : row.agents[row.agent]?.sessionId
    // Written before the older rows go, so a failed write loses neither.
    const older =
      row.agent !== null && session !== undefined
        ? records
            .closed(row.projectId)
            .filter(
              (one) =>
                one.id !== row.id &&
                one.agent === row.agent &&
                one.agents[row.agent!]?.sessionId === session,
            )
        : []
    records.insertClosed(row)
    for (const one of older) this.gone(one)
    this.announce(row)
  }

  /** Adds the sealed screen to a row, if it is still there. */
  private keep(id: string, sealed: string): void {
    const current = this.host.records?.closedTerminal(id)
    if (current) this.host.records?.insertClosed({ ...current, transcript: sealed })
  }

  // Reading

  /** A project's closed terminals, newest first, each with whether it can be restored now. */
  async list(projectId: string): Promise<ClosedTerminal[]> {
    const rows = this.host.records?.closed(projectId) ?? []
    const pass = newPass()
    return pooled(rows, (row) => this.wire(row, pass))
  }

  /** Every closed terminal, `synced`, then each later change, until `signal` aborts. */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<HistoryChange> {
    if (this.host.stopping()) throw new DomainError("CLOSING")
    // Changes made while the rows are checked are applied after them.
    const meanwhile: HistoryChange[] = []
    this.early.add(meanwhile)
    let rows: ClosedTerminal[]
    try {
      const pass = newPass()
      rows = await pooled(this.all(), (row) => this.wire(row, pass))
    } finally {
      this.early.delete(meanwhile)
    }
    if (this.host.stopping()) throw new DomainError("CLOSING")
    const watcher = new KeyedChanges<string, HistoryChange>(
      rows.map((closed) => [closed.id, { type: "changed", closed }] as const),
      { type: "synced" },
    )
    for (const change of meanwhile) this.apply(watcher, change)
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

  private all(): ListedClosed[] {
    const { records } = this.host
    return records ? this.host.projects().flatMap((project) => [...records.closed(project)]) : []
  }

  private async wire(row: ListedClosed, pass?: Pass): Promise<ClosedTerminal> {
    const availability = await this.availability(row, false, pass)
    const { title } = summaryTitle(row.naming, {
      handle: row.handle,
      command: row.command,
      openedBy: null,
    })
    return {
      id: row.id,
      projectId: row.projectId,
      title,
      summary: clip(row.naming.summary, historyLimits.summary),
      handle: row.handle,
      agent: row.agent,
      program: row.agent === null ? clip(row.lastProgram, historyLimits.program) : null,
      cwd: row.cwd,
      closedAt: row.closedAt,
      closedBy: row.closedBy,
      availability,
    }
  }

  /** Tells watchers of a row as it is now. */
  private announce(row: ListedClosed): void {
    const n = (this.counter += 1)
    this.latest.set(row.id, n)
    void this.wire(row)
      .then((closed) => {
        if (this.latest.get(row.id) === n) this.emit({ type: "changed", closed })
      })
      .catch((error: unknown) =>
        log.error("history.announce-failed", "Novadeck could not check a closed terminal", {
          err: error,
        }),
      )
  }

  private remove(row: { readonly id: string; readonly projectId: string }): void {
    this.latest.delete(row.id)
    this.restoring.delete(row.id)
    this.archiving.delete(row.id)
    this.emit({ type: "removed", id: row.id, projectId: row.projectId })
  }

  private emit(change: HistoryChange): void {
    for (const watcher of this.watchers.keys()) this.apply(watcher, change)
    for (const pending of this.early) pending.push(change)
  }

  private apply(watcher: KeyedChanges<string, HistoryChange>, change: HistoryChange): void {
    if (change.type === "changed") watcher.changed(change.closed.id, change)
    else if (change.type === "removed") watcher.removed(change.id, change)
  }

  /** Deletes the rows closed more than 30 days ago, and tells watchers. */
  prune(now = Date.now()): void {
    const { records } = this.host
    if (!records) return
    try {
      const cutoff = now - retentionMs
      const owners = new Map<string, string>()
      for (const row of this.all()) if (row.closedAt < cutoff) owners.set(row.id, row.projectId)
      for (const id of records.pruneClosed(cutoff)) {
        const projectId = owners.get(id)
        if (projectId) this.remove({ id, projectId })
      }
    } catch (error) {
      log.error("history.prune-failed", "Novadeck could not prune closed terminals", { err: error })
    }
  }

  // Availability

  /**
   * Whether the row can be restored now: not already, its harness connected, its conversation
   * and folder there, and the session not open in another terminal. What can't be told, as a
   * file the process may not read, counts as there; so does a check that takes too long.
   */
  async availability(
    row: ListedClosed,
    restoringIsOwn = false,
    pass?: Pass,
  ): Promise<ClosedTerminalState> {
    if (this.archiving.has(row.id) || (!restoringIsOwn && this.restoring.has(row.id)))
      return { state: "restoring" }
    const agent = resumeOf(row)
    if (agent === undefined) {
      // A plain row whose saved output did not open stays, with its terminal running beside it.
      const beside = this.host.restoredBeside(row.id)
      return beside === undefined ? { state: "ready" } : { state: "open", ...beside }
    }
    const report = row.agents[agent]
    if (!report) return { state: "gone", reason: "conversation" }
    let asked = pass?.connected.get(agent)
    if (!asked) {
      asked = this.host.connected(agent).catch(() => true)
      pass?.connected.set(agent, asked)
    }
    if (!(await asked)) return { state: "disconnected", agent }
    const holder = this.host.holder(agent, report.sessionId)
    if (holder !== undefined) return { state: "open", ...holder }
    const checked = await Promise.race([
      this.files(agent, report, row, pass),
      new Promise<ClosedTerminalState>((resolve) =>
        setTimeout(() => resolve({ state: "ready" }), this.times.checkMs).unref(),
      ),
    ])
    return checked
  }

  private async files(
    agent: AgentName,
    report: AgentReport,
    row: Pick<ListedClosed, "cwd">,
    pass?: Pass,
  ): Promise<ClosedTerminalState> {
    try {
      if (await folderGone(report.cwd ?? row.cwd)) return { state: "gone", reason: "folder" }
      const install = await this.host.install(agent)
      if (!install) return { state: "ready" }
      const known = { transcript: report.transcript }
      // One scan per agent for a whole list: each folder is read once, whatever the rows.
      let scan = pass?.scans.get(agent)
      if (!scan) {
        scan = harnesses[agent].conversations(install)
        pass?.scans.set(agent, scan)
      }
      const found = await scan.conversation(report.sessionId, known)
      return found === "gone" ? { state: "gone", reason: "conversation" } : { state: "ready" }
    } catch {
      return { state: "ready" }
    }
  }

  /**
   * Whether an agent running with this session could be restored if closed (see `restorable`).
   * Until `settled`, a turn having ended, no conversation file reads as gone: it is not written yet.
   */
  async restorable(agent: AgentName, sessionId: string, settled = true): Promise<boolean> {
    if (!(await this.host.connected(agent).catch(() => true))) return false
    const install = await this.host.install(agent).catch(() => undefined)
    if (!install) return true
    const known = { transcript: this.host.transcriptOf(agent, sessionId) }
    const found = await harnesses[agent]
      .conversation(install, sessionId, known)
      .catch(() => "unknown")
    return found !== "gone" || !settled
  }

  // Restore

  /**
   * Restores the row `input.closed` as the terminal `input.id` through `start`, which makes
   * the terminal from the plan. The row is refused if unknown (NOT_FOUND), or if it can't be
   * restored now (CONFLICT); a create repeated with the same new id answers with the terminal
   * the first made, never CONFLICT.
   */
  restore<I extends RestoreInput>(
    input: I,
    start: (plan: Plan, input: I) => Promise<TerminalSummary>,
  ): Promise<TerminalSummary> {
    const { closed } = input
    if (closed === undefined) return Promise.reject(new DomainError("NOT_FOUND"))
    const running = this.inflight.get(input.id)
    if (running?.row === closed) return running.done
    const existing = this.host.restoredAs(input.id, closed)
    if (existing) return Promise.resolve(existing)
    const done = this.restoreRow(closed, input, start)
    this.inflight.set(input.id, { row: closed, done })
    const forget = () => {
      if (this.inflight.get(input.id)?.done === done) this.inflight.delete(input.id)
    }
    done.then(forget, forget)
    return done
  }

  private async restoreRow<I extends RestoreInput>(
    rowId: string,
    input: I,
    start: (plan: Plan, input: I) => Promise<TerminalSummary>,
  ): Promise<TerminalSummary> {
    const { records } = this.host
    const row = records?.closedTerminal(rowId)
    if (!row || row.projectId !== this.host.projectOf(input.sessionId))
      throw new DomainError("NOT_FOUND", "That closed terminal is not in this project's History.")
    if (this.restoring.has(rowId))
      throw new DomainError("CONFLICT", "That terminal is already being restored.")
    // Taken before anything waits, so a second restore of the row is refused.
    this.restoring.add(rowId)
    try {
      const state = await this.availability(row, true)
      if (state.state !== "ready") throw new DomainError("CONFLICT", refusal(state))
      this.announce(row)
      return await start(this.plan(row), input)
    } catch (error) {
      this.restoring.delete(rowId)
      this.announce(row)
      throw error
    }
  }

  private plan(row: ClosedRecord): Plan {
    const resume = resumeOf(row)
    const report = resume && row.agents[resume]
    // The session's own folder, where its harness finds the conversation.
    const cwd = report?.cwd ?? row.cwd
    return {
      resume,
      saved: {
        id: row.id,
        sessionId: row.sessionId,
        handle: row.handle,
        naming: row.naming,
        openedBy: null,
        ledBy: null,
        command: row.command,
        lastProgram: row.lastProgram,
        work: null,
        cwd,
        agents: row.agents,
        promptedAt: null,
        interruptions: row.interruptions,
        transcript: row.transcript,
        savedAt: row.closedAt,
      },
      identity: (sessionId) => ({
        handle: this.handleFor(row, sessionId),
        naming: row.naming,
        openedBy: null,
        ledBy: null,
      }),
      started: (record, resumes, opened, shown) =>
        this.started(row, resume, record, resumes, opened, shown),
    }
  }

  /**
   * The handle the restored terminal has in the session: its own, unless a terminal there has
   * it, leads under it (a restored lead must not regain workers by name), or another
   * terminal of that session was given it. Else one the session never gave.
   */
  private handleFor(row: ClosedRecord, sessionId: string): string {
    const taken = this.host
      .terminalsIn(sessionId)
      .some((terminal) => terminal.handle === row.handle || terminal.ledBy === row.handle)
    // A handle the session gave this very terminal is recorded already.
    const adopted =
      !taken &&
      (row.sessionId === sessionId || this.host.records?.adoptHandle(sessionId, row.handle))
    return adopted ? row.handle : this.host.drawHandle(sessionId)
  }

  private started(
    row: ClosedRecord,
    resume: AgentName | undefined,
    record: Closing,
    resumes: boolean,
    opened: boolean,
    shown: Promise<void> = Promise.resolve(),
  ): void {
    record.restoredFrom = row.id
    const session = resume && row.agents[resume]?.sessionId
    if (resume === undefined || session === undefined) {
      if (row.transcript && !opened) {
        // Its saved output did not open, as with no key or too late: the row keeps it, and the
        // terminal stays beside it, a restore of the row already made.
        this.restoring.delete(row.id)
        this.announce(row)
      } else if (row.transcript) {
        // Its saved output is on the new terminal's screen, not yet in the copy that terminal
        // saves: the row stays, reading open beside it, until that copy is written. A terminal
        // closed first keeps its screen as its own row (see `closing`).
        this.restoring.delete(row.id)
        this.announce(row)
        this.pending.add(row.id)
        void shown.then(() =>
          this.host.saved(record, () => {
            if (this.pending.delete(row.id)) this.gone(row)
          }),
        )
      } else this.gone(row)
      return
    }
    record.restoring = {
      row: row.id,
      projectId: row.projectId,
      agent: resume,
      session,
      timer: setTimeout(() => this.timedOut(record), this.times.restoreMs),
    }
    record.restoring.timer.unref()
    // The terminal's creation tells the person why, in its own note.
    if (!resumes) this.failed(record, undefined, false)
    else this.observe(record)
  }

  private gone(row: { readonly id: string; readonly projectId: string }): void {
    try {
      this.host.records?.removeClosed(row.id)
    } catch (error) {
      log.error("history.remove-failed", "Novadeck could not remove a restored row", { err: error })
    }
    this.remove(row)
  }

  /**
   * Looks at a restored terminal for the harness's sign that its conversation resumed: the
   * row goes then. With `final`, the terminal is closing, so a prompt that returned counts.
   */
  observe(record: Closing, final = false): void {
    const waiting = record.restoring
    if (!waiting) return
    const bound = record.bound?.binding
    const ready = record.summary.ready !== null
    if (ready) waiting.readySince ??= Date.now()
    const seen = harnesses[waiting.agent].launch.resumed(waiting.session, {
      sessionId: bound?.agent === waiting.agent ? bound.sessionId : null,
      ready,
      readyMs: waiting.readySince === undefined ? 0 : Date.now() - waiting.readySince,
    })
    if (seen === "worked") this.worked(record, waiting)
    else if (seen === "failed" && !final) this.failed(record)
    else if (seen === "waiting" && ready && !final && !waiting.recheck) {
      // A harness that waits a grace for its id says nothing more by itself: look once after it.
      waiting.recheck = setTimeout(() => {
        if (record.restoring === waiting) this.observe(record)
      }, this.times.graceMs)
      waiting.recheck.unref()
    }
  }

  /** The shell's prompt came back: a resume still not shown to have worked has failed. */
  prompted(record: Closing): void {
    if (!record.restoring) return
    this.observe(record)
    if (record.restoring) this.failed(record)
  }

  /** The terminal's shell ended, or typing took the startup over: the resume did not happen. */
  cancelled(record: Closing): void {
    if (record.restoring) this.failed(record, undefined, false)
  }

  private worked(record: Closing, waiting: Restoring): void {
    clearTimeout(waiting.timer)
    clearTimeout(waiting.recheck)
    record.restoring = undefined
    this.gone({ id: waiting.row, projectId: waiting.projectId })
  }

  /**
   * The resume failed: the session is given back, the row checked again and left where it
   * was, and the terminal stays as a plain shell, with a line saying why unless `say` is false.
   */
  private failed(record: Closing, why?: string, say = true): void {
    const waiting = record.restoring
    if (!waiting) return
    clearTimeout(waiting.timer)
    clearTimeout(waiting.recheck)
    record.restoring = undefined
    // A claim survives a failed resume, and would hold the session from every other terminal.
    this.host.releaseClaim(record.summary.id)
    this.restoring.delete(waiting.row)
    const row = this.host.records?.closedTerminal(waiting.row)
    if (!row) return
    void (async () => {
      const state = await this.availability(row)
      this.announce(row)
      if (!say) return
      const label = agentLabel(waiting.agent)
      const note =
        why !== undefined
          ? `${label} was running here, but wasn't resumed: ${why}.`
          : state.state === "gone" && state.reason === "conversation"
            ? resumeNote({ ok: false, reason: "conversation-gone" }, waiting.agent, true)
            : `${label} was running here, but its conversation didn't open.`
      if (note) this.host.say(record, note)
    })().catch((error: unknown) =>
      log.error("history.check-failed", "Novadeck could not check a closed terminal", {
        err: error,
      }),
    )
  }

  /**
   * A resume held too long, as at a dialog: the row stops reading as restoring, and the terminal
   * stays. The restore stays pending, so a later bind still removes the row and a later failure
   * still gives the claim back.
   */
  private timedOut(record: Closing): void {
    const waiting = record.restoring
    if (!waiting) return
    this.restoring.delete(waiting.row)
    const row = this.host.records?.closedTerminal(waiting.row)
    if (row) this.announce(row)
  }

  /** The terminal is closing with its restore unconfirmed: the row is where it was. */
  private settle(record: Closing): void {
    const waiting = record.restoring
    if (!waiting) return
    clearTimeout(waiting.timer)
    clearTimeout(waiting.recheck)
    record.restoring = undefined
    this.restoring.delete(waiting.row)
    const row = this.host.records?.closedTerminal(waiting.row)
    if (row) this.announce(row)
  }

  // Restorable

  /**
   * Judges whether the terminal could be restored if it closed (`TerminalSummary.restorable`):
   * a shell yes; an agent without a session no (one typed there, or one expected); one with a
   * session while its harness is connected and its conversation not known gone. Judged again
   * when the bound session changes, when one of its turns ends, and when `again` is set, as
   * a connection changed. A session that has had no turn has no conversation file yet, which
   * is not a gone one.
   */
  judge(record: Closing, again = false): void {
    const bound = record.bound?.binding
    const expected = !bound && (record.expecting || isAgentName(record.summary.process?.name))
    // An agent not bound yet, as a resumed or restored Codex is before its first prompt, is
    // judged by the session it reported last, as closing keeps its row by it.
    const reported = expected ? latestAgent(record.agents) : null
    const target = bound
      ? { agent: bound.agent, sessionId: bound.sessionId }
      : reported
        ? { agent: reported, sessionId: record.agents[reported]!.sessionId }
        : undefined
    const session = target ? `${target.agent}:${target.sessionId}` : undefined
    const turns = this.turnsOf(record, session)
    const key = session
      ? `${session}:${turns.ended}${bound ? "" : ":reported"}`
      : expected
        ? "agent"
        : "shell"
    if (!again && record.restorableFor === key) return
    record.restorableFor = key
    const run = (turns.run += 1)
    if (!target) {
      this.restorableIs(record, key === "shell")
      return
    }
    const settled = !bound || turns.ended > 0 || record.restoredFrom !== undefined
    void this.restorable(target.agent, target.sessionId, settled)
      .then((value) => {
        if (turns.run === run && record.restorableFor === key) this.restorableIs(record, value)
      })
      .catch(() => undefined)
  }

  /** What `judge` follows of a terminal's turns: how many ended under the bound session. */
  private turnsOf(record: Closing, session: string | undefined): Turns {
    let turns = this.turns.get(record)
    if (!turns) {
      turns = { session, working: false, ended: 0, run: 0 }
      this.turns.set(record, turns)
    }
    if (turns.session !== session) Object.assign(turns, { session, working: false, ended: 0 })
    const state = record.summary.activity?.state
    if (turns.working && state === "idle") turns.ended += 1
    if (state === "working") turns.working = true
    else if (state === "idle") turns.working = false
    return turns
  }

  private restorableIs(record: Closing, value: boolean): void {
    if (record.summary.restorable === value) return
    record.summary = { ...record.summary, restorable: value }
    this.host.announce(record)
  }
}

/** Why a row can't be restored, in a sentence for the person. */
const refusal = (state: ClosedTerminalState): string => {
  switch (state.state) {
    case "restoring":
      return "That terminal is already being restored."
    case "gone":
      return state.reason === "folder"
        ? "The folder that conversation ran in is gone."
        : "That conversation is gone."
    case "disconnected":
      return `Novadeck isn't connected to ${agentLabel(state.agent)}, so it can't resume its conversations.`
    case "open":
      return `That conversation is open in ${mention(state.handle)}.`
    case "ready":
      return "That terminal can be restored."
  }
}
