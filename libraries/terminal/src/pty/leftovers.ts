import { readFileSync } from "node:fs"

import {
  withBelow,
  processKey,
  termGraceMs,
  type Followed,
  type Listed,
  type Listing,
} from "./descendants.js"

/**
 * An agent's run in a terminal, in Linux's clock ticks since boot, as /proc/<pid>/stat gives a
 * process's start: from the start of the program the shell ran for it (the agent, or a wrapper
 * such as `npx` it runs under) until its session ended, or still open while it runs.
 */
export type AgentRun = { readonly since: number; readonly until?: number }

/**
 * Linux's clock ticks a second (`USER_HZ`): 100 on every architecture Novadeck ships for,
 * whatever the kernel's own tick.
 */
const ticksPerSecond = 100

/**
 * Now in clock ticks since boot, as a process's start reads: this process's own start, and the
 * time it has run since by the monotonic clock. Where the kernel counts starts by the clock
 * that runs through suspend, this falls behind by the time suspended since Novadeck started,
 * which only ever makes a run end earlier and spares more. Undefined where it can't be read.
 */
export const ticksNow = (
  stat: () => string = () => readFileSync("/proc/self/stat", "utf8"),
  uptime: () => number = () => process.uptime(),
): number | undefined => {
  let text: string
  try {
    text = stat()
  } catch {
    return undefined
  }
  const fields = text.slice(text.lastIndexOf(")") + 2).split(/\s+/)
  // After `(comm)`, the state is field 0 and the start field 19, as `parseStat` reads it.
  const started = Number(fields[19])
  return Number.isSafeInteger(started) ? started + Math.floor(uptime() * ticksPerSecond) : undefined
}

/** A listed process's start, as a number of clock ticks; undefined off Linux. */
const ticks = (row: Listed): number | undefined => {
  const value = Number(row.started)
  return /^\d+$/.test(row.started) && Number.isSafeInteger(value) ? value : undefined
}

/**
 * Where the agent `agent` began: its own start, which is its shell's where it took the shell's
 * place (`exec codex`). Never a wrapper's or a shell's it runs under, which may have started
 * long before and what the person ran there with it. Undefined where the listing doesn't show
 * it, as for a pid of a sandbox's own namespace.
 */
export const runStart = (rows: readonly Listed[], agent: number): number | undefined => {
  const lead = rows.find((row) => row.pid === agent)
  return lead && !lead.zombie ? ticks(lead) : undefined
}

const during = (start: number, runs: readonly AgentRun[]): boolean =>
  runs.some(({ since, until }) => start >= since && (until === undefined || start <= until))

/**
 * What an agent left in its terminal's scope, by one listing and the scope's `members`: the
 * live processes of each tree of the scope (by parent, inside the scope) whose root started
 * while an agent ran there (`runs`), with all under it. A program the agent started detached is
 * such a root, adopted outside the scope once its launching shell exited.
 *
 * Spared, with all under each: the shell's own tree while it runs, which its hangup and the
 * agent's follow (`agentProcesses`) end; trees whose root started before any agent or after its
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
}: {
  readonly rows: readonly Listed[]
  readonly members: readonly number[]
  readonly runs: readonly AgentRun[]
  readonly shell?: number | undefined
  readonly apart?: readonly Followed[]
  readonly skip?: ReadonlySet<string>
}): readonly Followed[] => {
  if (runs.length === 0) return []
  const inside = new Set(members)
  const scoped = rows.filter((row) => inside.has(row.pid) && !row.zombie && row.pid > 1)
  const byPid = new Map(scoped.map((row) => [row.pid, row]))
  const kept = new Set(
    withBelow(
      scoped,
      scoped.filter((row) =>
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
      if (kept.has(row.pid) || row.pid === shell || skip.has(processKey(row))) return false
      const root = rootOf(row)
      if (root.pid === shell) return false
      const start = ticks(root)
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

/**
 * Ends what `find` names, as `endFollowed` ends what a follow left: SIGTERM, with SIGCONT for
 * what is stopped, then SIGKILL `termGraceMs` on, or by `by()` where that comes first, as a quit
 * bounds it. Each by its pid, only right after a fresh listing has shown that pid to be the
 * process found, so never one that has since been given its pid; `find` is asked again before
 * SIGKILL, which reaches what the first ones started meanwhile too. Where it finds nothing,
 * as where the listing or the scope can't be read, nothing is signalled.
 */
export const endLeftovers = async (
  find: () => Promise<readonly Followed[] | undefined>,
  by: () => number = () => Number.POSITIVE_INFINITY,
): Promise<readonly Followed[]> => {
  const first = await find()
  if (!first || first.length === 0) return []
  signalEach(first, "SIGTERM")
  // A stopped process acts on neither until it runs again.
  signalEach(first, "SIGCONT")
  const until = Math.min(Date.now() + termGraceMs, by())
  while (first.some(({ pid }) => answers(pid)) && Date.now() < until)
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await sleep(Math.max(1, Math.min(50, until - Date.now())))
  const stubborn = await find()
  if (stubborn) signalEach(stubborn, "SIGKILL")
  return first
}

/** The listing and the scope's members together, for `leftovers`; undefined where either fails. */
export const readScope = async (
  listing: Listing,
  members: () => Promise<readonly number[] | undefined>,
): Promise<{ rows: readonly Listed[]; members: readonly number[] } | undefined> => {
  // Members first: what joins the scope after is listed, and what leaves it isn't a member.
  const inside = await members()
  if (!inside || inside.length === 0) return undefined
  const rows = await listing()
  return rows ? { rows, members: inside } : undefined
}
