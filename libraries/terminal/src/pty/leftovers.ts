import { readFileSync } from "node:fs"

import {
  withBelow,
  processKey,
  termGraceMs,
  type Followed,
  type Listed,
  type Listing,
} from "./descendants.js"
import type { ScopeMember } from "./scopes.js"
import { parseLstart } from "./spawned.js"

/**
 * An agent's run in a terminal, in its platform's `RunClock`: from the agent's own process's
 * start (`runStart`), or the time it bound where that can't be read, until its session ended,
 * or still open while it runs.
 */
export type AgentRun = { readonly since: number; readonly until?: number }

/**
 * Linux's clock ticks a second (`USER_HZ`): 100 on every architecture Novadeck ships for,
 * whatever the kernel's own tick.
 */
const ticksPerSecond = 100

/**
 * Now in clock ticks since boot, as a process's start reads: /proc/uptime, which counts the
 * same clock, the one that runs on through suspend. Undefined where it can't be read.
 */
export const ticksNow = (
  uptime: () => string = () => readFileSync("/proc/uptime", "utf8"),
): number | undefined => {
  let seconds: number
  try {
    seconds = Number.parseFloat(uptime())
  } catch {
    return undefined
  }
  return Number.isFinite(seconds) ? Math.floor(seconds * ticksPerSecond) : undefined
}

/** A listed process's start, as a number of clock ticks; undefined off Linux. */
const ticks = (row: Listed): number | undefined => {
  const value = Number(row.started)
  return /^\d+$/.test(row.started) && Number.isSafeInteger(value) ? value : undefined
}

/** The clock an agent's runs and the starts of what it left are compared in. */
export type RunClock = {
  /** Now; undefined where it can't be read. */
  now(): number | undefined
  /**
   * When `row` started, by its scope's word (`member`) where that gives one; undefined where
   * neither tells, or where they tell of two processes, a pid taken between the two reads.
   */
  start(row: Listed, member?: ScopeMember): number | undefined
}

/**
 * Linux's: clock ticks since boot, as /proc/<pid>/stat gives a process's start and
 * /proc/uptime counts on through suspend.
 */
export const tickClock: RunClock = { now: () => ticksNow(), start: (row) => ticks(row) }

/** A quarter of an hour, which every time zone's offset, and its daylight saving, is a multiple of. */
const zoneStepMs = 15 * 60 * 1000
/** The farthest apart two zones' clocks are. */
const zoneSpanMs = 26 * 60 * 60 * 1000

/**
 * Whether `listed`, a listing's `lstart` read in this process's zone, is the second
 * `startedMs` began in, in whatever zone the listing gave it: `ps` reads the system's zone as
 * it runs, and this process keeps the one it started with, which a trip or daylight saving
 * may since have moved by whole quarters of an hour. A pid taken by another process between
 * the scope's read and the listing's is told apart by its start's own seconds and minutes.
 */
const sameSecond = (startedMs: number, listed: number): boolean => {
  const apart = listed - Math.floor(startedMs / 1000) * 1000
  return Math.abs(apart) <= zoneSpanMs && apart % zoneStepMs === 0
}

/**
 * macOS's: milliseconds since the epoch, the wall clock a process's start is read in, as the
 * scope gives it to the microsecond. The listing's `lstart` gives only its second, which
 * would count what the person started in the second an agent started or ended as the agent's;
 * it is taken only where the scope gives none.
 */
export const wallClock: RunClock = {
  now: () => Date.now(),
  start: (row, member) => {
    const listed = parseLstart(row.started)
    if (member?.startedMs === undefined) return listed
    return listed === undefined || sameSecond(member.startedMs, listed)
      ? member.startedMs
      : undefined
  },
}

/** The clock `platform`'s runs are kept in. */
export const runClock = (platform: NodeJS.Platform): RunClock =>
  platform === "darwin" ? wallClock : tickClock

/**
 * Where the agent `agent` began: its own start, which is its shell's where it took the shell's
 * place (`exec codex`). Never a wrapper's or a shell's it runs under, which may have started
 * long before and what the person ran there with it. Undefined where the listing doesn't show
 * it, as for a pid of a sandbox's own namespace.
 */
export const runStart = (
  rows: readonly Listed[],
  agent: number,
  clock: RunClock = tickClock,
  members: readonly ScopeMember[] = [],
): number | undefined => {
  const lead = rows.find((row) => row.pid === agent)
  if (!lead || lead.zombie) return undefined
  return clock.start(
    lead,
    members.find((member) => member.pid === agent),
  )
}

const during = (start: number, runs: readonly AgentRun[]): boolean =>
  runs.some(({ since, until }) => start >= since && (until === undefined || start <= until))

/**
 * What an agent left in its terminal's scope, by one listing and the scope's `members`: the
 * live processes of each tree of the scope (by parent, inside the scope) whose root started
 * while an agent ran there (`runs`), with all under it. A program the agent started detached is
 * such a root, adopted outside the scope once its launching shell exited.
 *
 * Spared, with all under each: the shell's own tree while it runs, by the listing's parents, as
 * macOS's scope never holds an Apple shell, which its hangup and the agent's follow
 * (`agentProcesses`) end; trees whose root started before any agent or after its
 * session ended, as what the person started there by hand; and `apart`, what the agent's
 * harness runs apart from the terminal, as Claude Code's background service, found in the scope
 * of the terminal that started it. A process that has left the scope, as one `systemd-run` or D-Bus
 * activation started in a unit of its own, is never one. `skip` leaves out processes by
 * `processKey`, as what a follow still waits on.
 */
export const leftovers = ({
  rows,
  members,
  runs,
  shell,
  apart = [],
  skip = new Set(),
  clock = tickClock,
  partial = false,
}: {
  readonly rows: readonly Listed[]
  readonly members: readonly ScopeMember[]
  readonly runs: readonly AgentRun[]
  readonly shell?: number | undefined
  readonly apart?: readonly Followed[]
  readonly skip?: ReadonlySet<string>
  readonly clock?: RunClock
  /**
   * Whether the scope may leave out processes it holds, as macOS's leaves out every Apple
   * program (`TaggedScopes`): then a tree's root, and what lies under `apart`, are found by
   * the whole listing's parents, so a member under a person's own `bash` loop or `make` that
   * started before the agent is judged by that ancestor's start, never by its own. Only
   * members are ever named.
   */
  readonly partial?: boolean
}): readonly Followed[] => {
  if (runs.length === 0) return []
  const inside = new Map(members.map((member) => [member.pid, member]))
  const scoped = rows.filter((row) => inside.has(row.pid) && !row.zombie && row.pid > 1)
  // Where the scope may leave processes out, its members' parents are followed through all.
  const tree = partial ? rows.filter((row) => !row.zombie && row.pid > 1) : scoped
  const byPid = new Map(tree.map((row) => [row.pid, row]))
  const running = shell === undefined ? undefined : rows.find((row) => row.pid === shell)
  const underShell = new Set(
    running && !running.zombie ? withBelow(rows, [running]).map((row) => row.pid) : [],
  )
  const kept = new Set(
    withBelow(
      tree,
      tree.filter((row) =>
        apart.some(({ pid, started }) => pid === row.pid && started === row.started),
      ),
    ).map((row) => row.pid),
  )
  const roots = new Map<number, Listed>()
  const rootOf = (row: Listed): Listed => {
    const known = roots.get(row.pid)
    if (known) return known
    const chain: Listed[] = []
    let at = row
    for (let parent = byPid.get(at.parent); parent && !chain.includes(parent);) {
      chain.push(at)
      at = parent
      parent = byPid.get(at.parent)
    }
    const root = roots.get(at.pid) ?? at
    for (const one of [...chain, at]) roots.set(one.pid, root)
    return root
  }
  return scoped
    .filter((row) => {
      if (kept.has(row.pid) || row.pid === shell || underShell.has(row.pid)) return false
      if (skip.has(processKey(row))) return false
      const root = rootOf(row)
      if (root.pid === shell) return false
      const start = clock.start(root, inside.get(root.pid))
      return start !== undefined && during(start, runs)
    })
    .map(({ pid, started }) => ({ pid, started }))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const signalEach = (ones: readonly Followed[], signal: NodeJS.Signals): void => {
  for (const { pid } of ones)
    try {
      process.kill(pid, signal)
    } catch {
      // Gone meanwhile.
    }
}

/** Whether `pid` answers: past its exit, or another's by now. */
const answers = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** `found`, or undefined once `by()` has passed, whatever it waits on. */
const within = async <T>(found: Promise<T>, by: number): Promise<T | undefined> => {
  if (by === Number.POSITIVE_INFINITY) return found
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(resolve, Math.max(0, by - Date.now()), undefined)
  })
  return Promise.race([found, late]).finally(() => clearTimeout(timer))
}

/**
 * Ends what `find` names, as `endFollowed` ends what a follow left: SIGTERM, with SIGCONT for
 * what is stopped, then SIGKILL `termGraceMs` on, or by `by()` where that comes first, as a quit
 * bounds it; finding them is bounded by it too. Each by its pid, only right after a fresh
 * listing has shown that pid to be the process found, so never one that has since been given
 * its pid. SIGKILL goes only to what had SIGTERM: what `find` names for the first time then, as
 * a hook an ending agent started, is left for a later pass to ask first. Where it finds nothing,
 * as where the listing or the scope can't be read, nothing is signalled.
 */
export const endLeftovers = async (
  find: () => Promise<readonly Followed[] | undefined>,
  by: () => number = () => Number.POSITIVE_INFINITY,
): Promise<readonly Followed[]> => {
  const first = await within(find(), by())
  if (!first || first.length === 0) return []
  signalEach(first, "SIGTERM")
  // A stopped process acts on neither until it runs again.
  signalEach(first, "SIGCONT")
  const until = Math.min(Date.now() + termGraceMs, by())
  while (first.some(({ pid }) => answers(pid)) && Date.now() < until)
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await sleep(Math.max(1, Math.min(50, until - Date.now())))
  if (!first.some(({ pid }) => answers(pid))) return first
  // Past its bound, as at a quit's end, by the one look that stays quick.
  const again = await within(find(), Math.max(by(), Date.now() + 300))
  const asked = new Set(first.map(processKey))
  signalEach(again?.filter((one) => asked.has(processKey(one))) ?? [], "SIGKILL")
  return first
}

/** The listing and the scope's members together, for `leftovers`; undefined where either fails. */
export const readScope = async (
  listing: Listing,
  members: () => Promise<readonly ScopeMember[] | undefined>,
): Promise<{ rows: readonly Listed[]; members: readonly ScopeMember[] } | undefined> => {
  // Members first: what joins the scope after is listed, and what leaves it isn't a member.
  const inside = await members()
  if (!inside || inside.length === 0) return undefined
  const rows = await listing()
  return rows ? { rows, members: inside } : undefined
}
