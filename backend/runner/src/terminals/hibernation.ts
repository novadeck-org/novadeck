import type { AgentActivity, AgentName } from "@novadeck/protocol"
import {
  chainTo,
  hasChildProcess,
  hasJobUnder,
  placement,
  processKey,
  processListing,
  type Listing,
  type Member,
  type ProcessTrees,
} from "@novadeck/terminal/pty"

import { summary as activitySummary } from "../harnesses/activity.js"
import { logs } from "../log.js"
import type { Inbox } from "../messaging/inbox.js"
import type { Messaging } from "../messaging/messaging.js"
import type { Approvals } from "./approvals.js"
import { agentProcess } from "./ending.js"
import type { OpenRequests } from "./opens.js"
import type { Baseline, Record } from "./record.js"
import { scheduled } from "./schedules.js"
import type { Sleepers } from "./sleepers.js"

const log = logs.for("terminals")

/** How often idle agents are looked at, in milliseconds. */
export const sweepMs = 60_000

/**
 * How long after an agent binds its processes are recorded when no turn started first, in
 * milliseconds: its MCP servers and helpers are up by then, and nothing a turn started is.
 */
export const baselineMs = 10_000

/** The longest the terminal's screen is waited for before its agent is stopped, in milliseconds. */
export const screenMs = 2_000

/** Where an agent runs and what lives around it, as one read of the system told. */
export type Tree = {
  /** The agent runs under the terminal's shell. */
  readonly placed: boolean
  /** It holds the terminal's foreground, where the system tells it (always true on Windows). */
  readonly foreground: boolean
  /** The live processes under it, by pid and start. */
  readonly below: ReadonlySet<string>
  /** Each of them that has a parent among them, with that parent's key. */
  readonly lineage: ReadonlyMap<string, string>
  /** The shell started something besides the agent's own chain: a job, a server. */
  readonly beside: boolean
}

/** What hibernation needs to know of the processes: the read, and the baseline to compare with. */
export type TreeFacts = {
  readonly tree: Tree
  /** The processes recorded when the agent was up; undefined when none was. */
  readonly baseline: ReadonlySet<string> | undefined
}

/** Everything `mayHibernate` weighs, read from one terminal at one moment. */
export type Facts = {
  /** The wait in milliseconds; null when the person turned hibernation off. */
  readonly windowMs: number | null
  /** The terminal's shell is ending, or its terminal closed or already asleep. */
  readonly gone: boolean
  /** The agent bound to the terminal; null for a plain shell, which never rests. */
  readonly agent: AgentName | null
  /** The bound session is the one saved, its harness resumes, and a shell here can run it. */
  readonly resumable: boolean
  /** The agent's activity as clients see it; null with none. */
  readonly activity: AgentActivity | null
  /** The agent scheduled something that lives only in its process: a cron (see `schedules.ts`). */
  readonly scheduled: boolean
  /** The session has ended a turn, or the shell resumed it: there is a conversation to resume. */
  readonly turned: boolean
  /** The turn that ended last ran into a usage limit. */
  readonly limited: boolean
  /** An ask of the agent's waits in the person's Inbox. */
  readonly asks: boolean
  /** An approval or a request for a terminal waits for the agent, or on it. */
  readonly approvals: boolean
  /** A message, a lease or a typed reply is on its way to the agent. */
  readonly occupied: boolean
  /** The agent's box may hold the person's draft, or the doorbell's line. */
  readonly draft: boolean
  /** A client is attached, or reads the agent's chat. */
  readonly attached: boolean
  /** When the last turn ended, the person's last key, a client's last attach or detach, and the terminal began. */
  readonly stamps: {
    readonly turn: number | null
    readonly key: number | null
    readonly attach: number | null
    readonly born: number
  }
  /** What the system showed of the agent's processes; undefined while not read. */
  readonly processes: TreeFacts | undefined
}

/** Why an agent stays awake, the first that holds. */
export type Veto =
  | "off"
  | "gone"
  | "plain"
  | "unresumable"
  | "busy"
  | "scheduled"
  | "attention"
  | "limit"
  | "ask"
  | "approval"
  | "occupied"
  | "draft"
  | "attached"
  | "unturned"
  | "window"
  | "unread"
  | "elsewhere"
  | "background"
  | "unbaselined"
  | "stray"
  | "beside"

/**
 * What keeps an agent from being stopped at `now`, or undefined when nothing does. An agent
 * rests only when its terminal is quiet and nothing it started would die with it: no turn,
 * subagent, background job or wake-up, nothing waiting on the person or on it, no draft, no
 * client, a wait of the setting's length since its last turn end, key, client or start, and
 * the processes under it and beside it only those it started with.
 */
export const vetoOf = (facts: Facts, now: number): Veto | undefined => {
  const { windowMs, activity } = facts
  if (windowMs === null) return "off"
  if (facts.gone) return "gone"
  if (facts.agent === null) return "plain"
  if (!facts.resumable) return "unresumable"
  if (activity === null) return "busy"
  const waiting = activity.waiting
  if (
    activity.state !== "idle" ||
    activity.background !== null ||
    activity.subagents.length > 0 ||
    (waiting !== null && (waiting.jobs.length > 0 || waiting.wake))
  )
    return "busy"
  if (facts.scheduled) return "scheduled"
  if (activity.attention.pending > 0) return "attention"
  if (facts.limited) return "limit"
  if (facts.asks) return "ask"
  if (facts.approvals) return "approval"
  if (facts.occupied) return "occupied"
  if (facts.draft) return "draft"
  if (facts.attached) return "attached"
  if (!facts.turned) return "unturned"
  const { turn, key, attach, born } = facts.stamps
  const since = Math.max(turn ?? 0, key ?? 0, attach ?? 0, born)
  if (now - since < windowMs) return "window"
  const { processes } = facts
  if (processes === undefined) return "unread"
  if (!processes.tree.placed) return "elsewhere"
  if (!processes.tree.foreground) return "background"
  if (processes.baseline === undefined) return "unbaselined"
  if (stray(processes.tree, processes.baseline) !== undefined) return "stray"
  if (processes.tree.beside) return "beside"
  return undefined
}

/**
 * A live process under the agent that the baseline does not hold, nor
 * descends from one it holds: what `npx` starts late, a real server under its launcher.
 */
export const stray = (tree: Tree, baseline: ReadonlySet<string>): string | undefined => {
  const held = (key: string): boolean => {
    for (let at: string | undefined = key, steps = 0; at && steps < 256; steps += 1) {
      if (baseline.has(at)) return true
      at = tree.lineage.get(at)
    }
    return false
  }
  return [...tree.below].find((key) => !held(key))
}

/** Whether an agent may be stopped to rest at `now`; see `vetoOf`. */
export const mayHibernate = (facts: Facts, now: number): boolean => vetoOf(facts, now) === undefined

const keyOf = (member: Member): string => `${member.pid}:${member.startedAt}`

/**
 * Where the agent runs, from the relay's trees of the shell and of the agent. With parents
 * told, the wrappers between them (an npm shim) are its chain; with none, whatever the shell
 * started beside the agent's tree counts, wrapper included.
 */
export const windowsTree = (
  all: readonly Member[],
  own: readonly Member[],
  shell: number,
  agent: number,
): Tree => {
  const chain = chainTo(all, shell, agent) ?? []
  const below = own.filter((member) => member.pid !== agent)
  const keys = new Map(below.map((member) => [member.pid, keyOf(member)]))
  const lineage = new Map<string, string>()
  for (const member of below) {
    const parent = member.parent === undefined ? undefined : keys.get(member.parent)
    if (parent) lineage.set(keyOf(member), parent)
  }
  return {
    placed: all.some((member) => member.pid === agent),
    foreground: true,
    below: new Set(below.map(keyOf)),
    lineage,
    beside: hasJobUnder(all, shell, new Set([...own.map((member) => member.pid), ...chain])),
  }
}

/**
 * The processes under a bound agent and beside it, from the system, as hibernation and the
 * restart check both judge what the agent started: its tools and servers below it, the shell's
 * jobs beside it. `list` is the process listing, which a caller reading many terminals shares.
 * Undefined when it can't tell, or the agent's process isn't known.
 */
export const readTree = async (
  record: Record,
  trees: Pick<ProcessTrees, "read"> | undefined,
  list: () => ReturnType<Listing>,
  // Whether the shell has a job beside the agent's own chain, where the system can tell: by
  // its own look at the system's processes unless the caller has one to read it from, as a
  // caller reading many terminals has.
  jobs: (
    shell: number,
    chain: readonly number[],
  ) => Promise<boolean | undefined> | boolean | undefined = (shell, chain) =>
    hasChildProcess(shell, undefined, new Set(chain)),
): Promise<Tree | undefined> => {
  const shell = record.terminal.pty.pid
  const agent = agentProcess(record)
  if (shell === undefined || agent === undefined) return undefined
  if (process.platform === "win32") {
    if (!trees) return undefined
    const [all, own] = await Promise.all([trees.read(shell), trees.read(agent)])
    if (!all || !own) return undefined
    return windowsTree(all, own, shell, agent)
  }
  const rows = await list()
  if (!rows) return undefined
  const found = placement(rows, shell, agent)
  if (!found)
    return {
      placed: false,
      foreground: false,
      below: new Set(),
      lineage: new Map(),
      beside: true,
    }
  // Anything else on the shell's terminal: `npm run dev &` before the agent started.
  const beside = await jobs(shell, found.chain)
  return {
    placed: true,
    foreground: found.foreground,
    below: new Set(found.below.map(processKey)),
    lineage: found.lineage,
    // Where the system can't tell, nothing is assumed gone.
    beside: beside !== false,
  }
}

/** What hibernation reaches in the runner. */
export type HibernationHost = {
  readonly stopping: () => boolean
  /** Every terminal the runner holds. */
  readonly records: () => Iterable<Record>
  /** Idle minutes before an agent is stopped; null when never. */
  readonly minutes: () => number | null
  readonly messaging: () => Messaging
  readonly inbox: () => Inbox
  readonly approvals: () => Approvals
  readonly opens: () => OpenRequests
  readonly sleepers: () => Sleepers
  /** Whether anyone reads the terminal's chat. */
  readonly detailWatched: (terminalId: string) => boolean
  readonly trees: () => ProcessTrees
  /**
   * Whether the agent's box holds text, read from the screen as the doorbell reads it;
   * undefined when it can't be read.
   */
  readonly boxHolds: (record: Record) => Promise<boolean | undefined>
  /** Saves the terminal's screen as its transcript, as a normal save does, and waits for it. */
  readonly save: (record: Record) => Promise<void>
  /** Ends the terminal's pty and what it started as a quit does; settles once its program ended. */
  readonly end: (record: Record) => Promise<void>
  /** The ended terminal's place in the runner is let go and its agent rests as a sleeper. */
  readonly rested: (record: Record) => void
}

/** What one look at a terminal learned beyond its record: its processes, and its box. */
type Seen = { readonly tree?: Tree; readonly empty?: boolean; readonly resting?: boolean }

export type HibernationOptions = {
  /** How often idle agents are looked at, in milliseconds. */
  readonly sweepMs?: number
  /** How long after an agent binds its processes are recorded, in milliseconds. */
  readonly baselineMs?: number
  /** The wait in milliseconds, in place of the setting's minutes, as in some tests. */
  readonly windowMs?: number
}

/**
 * Stops idle agents so they do not all run at once. Each minute it looks at every terminal
 * (`vetoOf`), and an agent that has been quiet for the setting's wait, with nothing it
 * started still running, has its pty ended as a quit ends it; its session rests as a
 * sleeper, and the next message or look wakes it (`Sleepers`).
 */
export class Hibernation {
  private timer: ReturnType<typeof setInterval> | undefined
  private sweeping = false
  /** The setting as this sweep read it, once for all its terminals. */
  private minutes: { readonly value: number | null } | undefined
  /** The process listing of this sweep, shared by every terminal it reads. */
  private rows: ReturnType<Listing> | undefined
  private readonly listing: Listing
  /** When each terminal was first seen here, which a started terminal's wait begins from. */
  private readonly born = new WeakMap<Record, number>()
  /** The terminals being stopped: their `create` waits for the end. */
  private readonly ending = new Map<string, Promise<void>>()
  private readonly options: Required<Omit<HibernationOptions, "windowMs">> &
    Pick<HibernationOptions, "windowMs">

  constructor(
    private readonly host: HibernationHost,
    options: HibernationOptions = {},
  ) {
    this.options = { sweepMs, baselineMs, ...options }
    this.listing = processListing()
  }

  /** Begins looking at idle agents each minute. */
  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.sweep(), this.options.sweepMs)
    this.timer.unref()
  }

  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }

  /** The end of a terminal being stopped, if one is, for a `create` to wait for. */
  settling(terminalId: string): Promise<void> | undefined {
    return this.ending.get(terminalId)
  }

  /**
   * The terminal's agent state moved: its processes are recorded once, as its first turn
   * starts or `baselineMs` after it binds, whichever is first, so what its tools start later
   * is never taken for part of it.
   */
  look(record: Record): void {
    const { bound } = record
    const instance = bound?.binding.instance
    if (!bound || instance === null || instance === undefined) return
    let baseline = record.baseline
    if (baseline?.instance !== instance) {
      if (baseline) clearTimeout(baseline.timer)
      // A new process holds none of the schedules of the one before.
      record.schedules = undefined
      const made: Baseline = {
        instance,
        begun: false,
        timer: setTimeout(() => this.record(record, made), this.options.baselineMs),
      }
      made.timer.unref()
      record.baseline = made
      baseline = made
    }
    if (bound.activity.state === "working") this.record(record, baseline)
  }

  /** Reads the processes under the agent now, once, as its baseline. */
  private record(record: Record, baseline: Baseline): void {
    clearTimeout(baseline.timer)
    if (baseline.begun) return
    baseline.begun = true
    void this.read(record)
      .then((tree) => {
        if (tree?.placed) baseline.taken = tree.below
      })
      .catch(() => undefined)
  }

  /** One pass over the terminals; a pass still under way is not doubled. */
  async sweep(): Promise<void> {
    if (this.sweeping || this.host.stopping()) return
    this.sweeping = true
    this.minutes = { value: this.host.minutes() }
    try {
      for (const record of Array.from(this.host.records())) {
        if (this.host.stopping()) return
        // eslint-disable-next-line no-await-in-loop -- Each read is shared and short; one at a time.
        await this.consider(record)
      }
    } catch (error) {
      log.error("terminals.hibernation-failed", "Novadeck could not look for idle agents", {
        err: error,
      })
    } finally {
      this.sweeping = false
      this.minutes = undefined
      this.rows = undefined
    }
  }

  private async consider(record: Record): Promise<void> {
    // The cheap facts first: only an agent that is otherwise quiet has its processes read.
    const now = Date.now()
    let empty = false
    let veto = vetoOf(this.facts(record, now), now)
    if (veto === "draft" && this.unsure(record)) {
      // Its delivery state doubts the box (Escape or a denial ended the turn, a ring failed):
      // the screen says whether it holds text.
      empty = (await this.host.boxHolds(record)) === false
      veto = vetoOf(this.facts(record, now, { empty }), now)
    }
    if (veto !== "unread") return
    // Without a baseline there is nothing to compare with, so nothing to read.
    const { baseline } = record
    if (!baseline?.taken || baseline.instance !== record.bound?.binding.instance) return
    const tree = await this.read(record)
    if (!tree) return
    // Asked again with nothing awaited between this and the decision: the agent may have
    // started a turn, or a person looked, while the system was read.
    const later = Date.now()
    if (!mayHibernate(this.facts(record, later, { tree, empty }), later)) return
    void this.rest(record, { tree, empty })
  }

  /** Whether the delivery state only doubts the box, which the screen can settle. */
  private unsure(record: Record): boolean {
    const state = this.host.messaging().delivery(record.summary.id)?.state
    return state === "unknown" || state === "fresh"
  }

  /**
   * Stops the terminal's agent: its pty ends as a quit does, and once it has, the terminal
   * rests as a sleeper; unless it was closed meanwhile, which the close finishes.
   */
  private async rest(record: Record, seen: Seen): Promise<void> {
    const { id } = record.summary
    const agent = record.bound?.binding.agent
    if (!agent) return
    // The program a fresh shell resumes, before anything samples the shell that is left. The
    // mark also keeps a message from being rung into an agent that is about to end.
    const before = record.summary.lastProgram
    const changed = record.changed
    record.summary = { ...record.summary, lastProgram: agent }
    record.changed = true
    record.hibernating = true
    const back = (): void => {
      record.hibernating = undefined
      record.summary = { ...record.summary, lastProgram: before }
      record.changed = changed
    }
    log.info("terminals.hibernate", "Stopping an idle agent", { data: { id, agent } })
    const ending = this.stopping(record, seen, back)
    this.ending.set(id, ending)
    await ending
    this.ending.delete(id)
    if (record.closed || record.hibernating !== true || this.host.stopping()) return
    this.host.rested(record)
  }

  /**
   * Saves the screen, looks once more at what may have moved meanwhile, and ends the pty.
   * Anything that moved, or an end that fails with the shell still running, leaves the agent
   * as it was: `back` clears the mark.
   */
  private async stopping(record: Record, seen: Seen, back: () => void): Promise<void> {
    await this.keepScreen(record)
    const now = Date.now()
    // Ignoring its own mark; the setting is read again, as a change counts at once.
    this.minutes = { value: this.host.minutes() }
    const veto = vetoOf(this.facts(record, now, { ...seen, resting: true }), now)
    this.minutes = undefined
    if (veto !== undefined || record.closed) return back()
    try {
      await this.host.end(record)
    } catch (error) {
      log.warn("terminals.hibernate-failed", "Novadeck could not stop an idle agent", {
        err: error,
      })
      // Gone all the same: the exit has been handled as a rest. Still running: it stays.
      if (record.terminal.exit === null) back()
    }
  }

  /**
   * The screen is saved with the row before the shell ends, so a wake that falls back to a
   * plain shell shows the latest. It waits no longer than `screenMs`.
   */
  private async keepScreen(record: Record): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, screenMs)
      timer.unref()
    })
    await Promise.race([this.host.save(record).catch(() => undefined), late])
    clearTimeout(timer)
  }

  /** The processes under the agent and beside it, from the system; undefined when it can't tell. */
  private read(record: Record): Promise<Tree | undefined> {
    return readTree(record, this.host.trees(), () =>
      this.sweeping ? (this.rows ??= this.listing()) : this.listing(),
    )
  }

  /** The terminal's facts at `now`, with what the system showed of its processes if read. */
  facts(record: Record, now: number, seen: Seen = {}): Facts {
    const { tree, empty = false, resting = false } = seen
    const { host } = this
    const { id } = record.summary
    const minutes = this.minutes ? this.minutes.value : host.minutes()
    const windowMs = minutes === null ? null : (this.options.windowMs ?? minutes * 60_000)
    if (!this.born.has(record)) this.born.set(record, now)
    const { bound } = record
    const agent = bound?.binding.agent ?? null
    const sessionId = bound?.binding.sessionId
    const report = agent === null ? undefined : record.agents[agent]
    const activity = bound ? activitySummary(bound.activity) : null
    const last = bound?.activity.lastTurn
    const ended = Math.max(last?.at ?? 0, report?.endedAt ?? 0)
    const delivery = host.messaging().delivery(id)
    const instance = bound?.binding.instance
    const baseline = record.baseline
    const settled = delivery?.state === "settled" || delivery?.state === "ready"
    return {
      windowMs,
      gone:
        record.closed ||
        (record.hibernating === true && !resting) ||
        record.terminal.exit !== null ||
        record.terminal.exiting,
      agent,
      resumable:
        agent !== null &&
        report?.sessionId === sessionId &&
        host.sleepers().restable(record, agent),
      activity,
      turned: ended > 0 || (agent !== null && record.resumeClaim === `${agent}:${sessionId ?? ""}`),
      scheduled: scheduled(record, sessionId, now),
      limited: last?.limited === true || last?.limit !== undefined,
      asks: host.inbox().hasOpenAsk(id),
      approvals: host.approvals().involves(id) || host.opens().asked(record.summary.handle),
      occupied: host.messaging().occupied(id),
      draft: !settled && !empty,
      attached: record.terminal.attached > 0 || host.detailWatched(id),
      stamps: {
        turn: ended > 0 ? ended : null,
        key: record.keyedAt ?? null,
        attach: record.attachedAt ?? null,
        born: this.born.get(record) ?? now,
      },
      processes: tree && {
        tree,
        baseline: baseline && baseline.instance === instance ? baseline.taken : undefined,
      },
    }
  }
}
