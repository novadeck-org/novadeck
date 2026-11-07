import type { AgentActivity, AgentName } from "@novadeck/protocol"
import {
  hasChildProcess,
  hasJobUnder,
  placement,
  processKey,
  processListing,
  type Listing,
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
import type { Sleepers } from "./sleepers.js"

const log = logs.for("terminals")

/** How often idle agents are looked at, in milliseconds. */
export const sweepMs = 60_000

/**
 * How long after an agent binds its processes are recorded when no turn started first, in
 * milliseconds: its MCP servers and helpers are up by then, and nothing a turn started is.
 */
export const baselineMs = 10_000

/** Where an agent runs and what lives around it, as one read of the system told. */
export type Tree = {
  /** The agent runs under the terminal's shell. */
  readonly placed: boolean
  /** It holds the terminal's foreground, where the system tells it (always true on Windows). */
  readonly foreground: boolean
  /** The live processes under it, by pid and start. */
  readonly below: ReadonlySet<string>
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
  for (const process of processes.tree.below) if (!processes.baseline.has(process)) return "stray"
  if (processes.tree.beside) return "beside"
  return undefined
}

/** Whether an agent may be stopped to rest at `now`; see `vetoOf`. */
export const mayHibernate = (facts: Facts, now: number): boolean => vetoOf(facts, now) === undefined

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
  /** Ends the terminal's pty and what it started as a quit does; settles once its program ended. */
  readonly end: (record: Record) => Promise<void>
  /** The ended terminal's place in the runner is let go and its agent rests as a sleeper. */
  readonly rested: (record: Record) => void
}

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
    }
  }

  private async consider(record: Record): Promise<void> {
    // The cheap facts first: only an agent that is otherwise quiet has its processes read.
    const now = Date.now()
    if (vetoOf(this.facts(record, now, undefined), now) !== "unread") return
    const tree = await this.read(record)
    if (!tree) return
    // Asked again with nothing awaited between this and the decision: the agent may have
    // started a turn, or a person looked, while the system was read.
    const later = Date.now()
    if (!mayHibernate(this.facts(record, later, tree), later)) return
    void this.rest(record)
  }

  /**
   * Stops the terminal's agent: its pty ends as a quit does, and once it has, the terminal
   * rests as a sleeper; unless it was closed meanwhile, which the close finishes.
   */
  private async rest(record: Record): Promise<void> {
    const { id } = record.summary
    const agent = record.bound?.binding.agent
    if (!agent) return
    // The program a fresh shell resumes, before anything samples the shell that is left.
    record.summary = { ...record.summary, lastProgram: agent }
    record.changed = true
    record.hibernating = true
    log.info("terminals.hibernate", "Stopping an idle agent", { data: { id, agent } })
    const ending = this.host.end(record).catch(() => undefined)
    this.ending.set(id, ending)
    await ending
    this.ending.delete(id)
    if (record.closed || this.host.stopping()) return
    this.host.rested(record)
  }

  /** The processes under the agent and beside it, from the system; undefined when it can't tell. */
  private async read(record: Record): Promise<Tree | undefined> {
    const shell = record.terminal.pty.pid
    const agent = agentProcess(record)
    if (shell === undefined || agent === undefined) return undefined
    if (process.platform === "win32") {
      const trees = this.host.trees()
      const [all, own] = await Promise.all([trees.read(shell), trees.read(agent)])
      if (!all || !own) return undefined
      return {
        placed: all.some((member) => member.pid === agent),
        foreground: true,
        below: new Set(
          own.filter((member) => member.pid !== agent).map((m) => `${m.pid}:${m.startedAt}`),
        ),
        beside: hasJobUnder(all, shell, new Set(own.map((member) => member.pid))),
      }
    }
    const rows = await this.listing()
    if (!rows) return undefined
    const found = placement(rows, shell, agent)
    if (!found) return { placed: false, foreground: false, below: new Set(), beside: true }
    // Anything else on the shell's terminal: `npm run dev &` before the agent started.
    const jobs = await hasChildProcess(shell, undefined, new Set(found.chain))
    return {
      placed: true,
      foreground: found.foreground,
      below: new Set(found.below.map(processKey)),
      // Where the system can't tell, nothing is assumed gone.
      beside: jobs !== false,
    }
  }

  /** The terminal's facts at `now`, with what the system showed of its processes if read. */
  facts(record: Record, now: number, tree: Tree | undefined): Facts {
    const { host } = this
    const { id } = record.summary
    const minutes = host.minutes()
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
        record.hibernating === true ||
        record.terminal.exit !== null ||
        record.terminal.exiting,
      agent,
      resumable:
        agent !== null &&
        report?.sessionId === sessionId &&
        host.sleepers().restable(record, agent),
      activity,
      turned: ended > 0 || (agent !== null && record.resumeClaim === `${agent}:${sessionId ?? ""}`),
      limited: last?.limited === true || last?.limit !== undefined,
      asks: host.inbox().hasOpenAsk(id),
      approvals: host.approvals().involves(id) || host.opens().asked(record.summary.handle),
      occupied: host.messaging().occupied(id),
      draft: !settled,
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
