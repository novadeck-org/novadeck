import { notice } from "./closes.js"
import { mention } from "./handles.js"

// What the host's load is read as, and when it is told. These are facts about when a machine
// is hard pressed, never advice: agents judge what to do with them.

/** How often the host and its terminals' processes are read, in milliseconds. */
export const hostPollMs = 5_000

/** The CPU use, in percent of the whole machine, from which a listing shows the host's load. */
export const cpuListedPercent = 60

/** The CPU use from which the host counts as hard pressed, in percent of the whole machine. */
export const cpuHighPercent = 90

/** The memory in use, in percent, from which a listing shows it, and it counts as high. */
export const memoryHighPercent = 90

/**
 * How long a high stretch is shown by its length: shorter ones are a spike. Also the least
 * a listing says "for" of.
 */
export const shownHighMs = 60_000

/** How long the host must stay high for the strain to be told to the terminals causing it. */
export const strainMs = 180_000

/**
 * How long the host must stay below high for a high stretch to end: dips shorter than this
 * (a build's link step, a test run's pause) leave the stretch running.
 */
export const calmMs = 60_000

/** The least a terminal uses of the machine's CPU, in percent, for a listing to name it. */
export const namedPercent = 5

/** How many terminals a listing names. */
export const namedMost = 5

/** The least a terminal uses of the machine's CPU, in percent, to count among a strain's contributors. */
export const contributorPercent = 10

/** What the host looked like when it was read. */
export type HostReading = {
  readonly at: number
  /** The processor time all cores spent not idle since boot, in milliseconds. */
  readonly busyMs: number
  /** The processor time all cores had since boot, in milliseconds. */
  readonly totalMs: number
  /** The share of memory in use, in percent; undefined where it can't be told. */
  readonly memoryPercent?: number | undefined
}

/** A process of a terminal's tree: the processor time it used itself, so far. */
export type Program = { readonly pid: number; readonly name: string; readonly ms: number }

/** The processor time a terminal's whole process tree used so far, and its processes. */
export type TerminalCpu = { readonly ms: number; readonly programs: readonly Program[] }

/** How much of the machine a terminal used since the last reading. */
export type Share = {
  /** Percent of the whole machine's CPU. */
  readonly percent: number
  /** The program of its tree that used the most of it; null when none stands out. */
  readonly program: string | null
}

/** The host's load between two readings. */
export type Load = {
  readonly at: number
  /** Percent of the whole machine's CPU in use. */
  readonly cpu: number
  /** Percent of memory in use; undefined where it can't be told. */
  readonly memory: number | undefined
  /** How long CPU has been high, in milliseconds; 0 when it is not. */
  readonly cpuHighFor: number
  /** How long memory has been high, in milliseconds; 0 when it is not. */
  readonly memoryHighFor: number
  /** What each terminal used of the CPU, by its id; none for a terminal first read now. */
  readonly shares: ReadonlyMap<string, Share>
}

/** A stretch of high load: it starts when the load is high, and ends once calm. */
class Stretch {
  private since: number | null = null
  private last = 0

  update(at: number, high: boolean): void {
    if (high) {
      this.last = at
      this.since ??= at
    } else if (this.since !== null && at - this.last >= calmMs) this.since = null
  }

  forMs(at: number): number {
    return this.since === null ? 0 : at - this.since
  }

  reset(): void {
    this.since = null
  }
}

const withoutExe = (name: string): string => name.replace(/\.exe$/i, "")

/** The program using the most processor time between two readings, by name; null if none did. */
const heaviest = (before: ReadonlyMap<number, number>, now: readonly Program[]): string | null => {
  const used = new Map<string, number>()
  for (const { pid, name, ms } of now) {
    const delta = ms - (before.get(pid) ?? 0)
    if (delta > 0) used.set(name, (used.get(name) ?? 0) + delta)
  }
  const [top] = [...used].toSorted((a, b) => b[1] - a[1])
  return top ? withoutExe(top[0]) : null
}

/**
 * The host's load from its readings, and what each terminal's processes used of it: every
 * reading is read against the last, so what this holds is the load between them. Pure: the
 * readings come from outside.
 */
export class HostLoad {
  private last:
    | { readonly host: HostReading; readonly terminals: ReadonlyMap<string, TerminalCpu> }
    | undefined
  private readonly cpuStretch = new Stretch()
  private readonly memoryStretch = new Stretch()

  /** The load as of the latest reading that had an earlier one to compare with. */
  current: Load | undefined

  /** Forgets what was read, as when no terminal's agent is left to tell. */
  reset(): void {
    this.last = undefined
    this.current = undefined
    this.cpuStretch.reset()
    this.memoryStretch.reset()
  }

  ingest(host: HostReading, terminals: ReadonlyMap<string, TerminalCpu>): Load | undefined {
    const before = this.last
    this.last = { host, terminals }
    if (!before) return undefined
    const total = host.totalMs - before.host.totalMs
    if (total <= 0) return this.current
    const percent = (ms: number): number => Math.min(100, Math.max(0, (ms / total) * 100))
    const cpu = percent(host.busyMs - before.host.busyMs)
    const memory = host.memoryPercent
    this.cpuStretch.update(host.at, cpu >= cpuHighPercent)
    this.memoryStretch.update(host.at, memory !== undefined && memory >= memoryHighPercent)
    const shares = new Map<string, Share>()
    for (const [id, now] of terminals) {
      const earlier = before.terminals.get(id)
      if (!earlier) continue
      shares.set(id, {
        percent: percent(now.ms - earlier.ms),
        program: heaviest(new Map(earlier.programs.map(({ pid, ms }) => [pid, ms])), now.programs),
      })
    }
    this.current = {
      at: host.at,
      cpu,
      memory,
      cpuHighFor: this.cpuStretch.forMs(host.at),
      memoryHighFor: this.memoryStretch.forMs(host.at),
      shares,
    }
    return this.current
  }
}

/** A length of time as people say it: "4 min". */
const minutes = (ms: number): string => `${Math.max(1, Math.floor(ms / 60_000))} min`

/** One terminal's use of the CPU as listed: "@fox 41% (rustc)". */
const shown = (name: string, { percent, program }: Share): string =>
  `${name} ${Math.round(percent)}%${program ? ` (${program})` : ""}`

/**
 * The terminals of `names` (a terminal's id to its handle) using at least `least` percent of
 * the CPU, the biggest first.
 */
const heaviestOf = (
  load: Load,
  names: ReadonlyMap<string, string>,
  least: number,
): { readonly id: string; readonly name: string; readonly share: Share }[] =>
  [...load.shares]
    .flatMap(([id, share]) => {
      const name = names.get(id)
      return name !== undefined && share.percent >= least ? [{ id, name, share }] : []
    })
    .toSorted((a, b) => b.share.percent - a.share.percent)

/** How long a high stretch has lasted, where it lasted long enough to say: " (90% or more for 4 min)". */
const forHow = (percent: number, held: number): string =>
  held >= shownHighMs ? ` (${percent}% or more for ${minutes(held)})` : ""

/**
 * What a listing says of the host's load, for the terminals of `names` (their handles
 * without the "@", by id; `callerId` shown as "you"); undefined when the host is not
 * hard pressed enough to be worth saying, or nothing was read.
 */
export const renderHost = (
  load: Load | undefined,
  names: ReadonlyMap<string, string>,
  callerId: string,
): string | undefined => {
  if (!load) return undefined
  const cpuShown = load.cpu >= cpuListedPercent
  const memoryShown = load.memory !== undefined && load.memory >= memoryHighPercent
  if (!cpuShown && !memoryShown) return undefined
  const parts = [
    ...(cpuShown ? [`CPU ${Math.round(load.cpu)}%${forHow(cpuHighPercent, load.cpuHighFor)}`] : []),
    ...(memoryShown
      ? [
          `memory ${Math.round(load.memory!)}% in use${forHow(memoryHighPercent, load.memoryHighFor)}`,
        ]
      : []),
  ]
  const lines = [`Host load now: ${parts.join(", ")}.`]
  if (cpuShown) {
    const top = heaviestOf(load, names, namedPercent).slice(0, namedMost)
    const named = top.map(({ id, name, share }) =>
      shown(id === callerId ? "you" : mention(name), share),
    )
    const rest = Math.max(0, load.cpu - top.reduce((sum, { share }) => sum + share.percent, 0))
    lines.push(
      `Most CPU, of the machine's: ${[
        ...named,
        `everything else (other projects, other programs) ${Math.round(rest)}%`,
      ].join(", ")}.`,
    )
  }
  return lines.join("\n")
}

/** A terminal whose agent a strain may be told to. */
export type Agent = {
  readonly id: string
  readonly handle: string
  /** Its project and session: only terminals in one are told of each other. */
  readonly sessionId: string
  /** It waits on the person (an approval or a question). */
  readonly waiting: boolean
}

/**
 * Tells the agents whose terminals keep a strained host strained, once each per strain: a
 * strain is a stretch of high CPU that lasted `strainMs`, which ends once the CPU has been
 * calm (`calmMs`). Only a project and session with two or more such terminals is told, each
 * of them its own words naming them all by what they use; one that waits on the person is
 * named but not told.
 */
export class Strain {
  private readonly told = new Set<string>()

  /**
   * Sends the notices due now through `send`, which says whether one was taken; a notice
   * not taken is due again at the next reading. Returns the ids told now.
   */
  run(
    load: Load,
    agents: readonly Agent[],
    send: (id: string, text: string) => boolean,
  ): readonly string[] {
    if (load.cpuHighFor === 0) this.told.clear()
    if (load.cpuHighFor < strainMs) return []
    const sent: string[] = []
    for (const sessionId of new Set(agents.map((agent) => agent.sessionId))) {
      const group = agents.filter((agent) => agent.sessionId === sessionId)
      const contributors = group
        .flatMap((agent) => {
          const share = load.shares.get(agent.id)
          return share && share.percent >= contributorPercent ? [{ agent, share }] : []
        })
        .toSorted((a, b) => b.share.percent - a.share.percent)
      if (contributors.length < 2) continue
      for (const { agent } of contributors) {
        if (agent.waiting || this.told.has(agent.id)) continue
        const list = contributors.map(({ agent: each, share }) =>
          shown(each.id === agent.id ? "you" : mention(each.handle), share),
        )
        const text =
          `${notice}Host CPU has been at ${cpuHighPercent}% or more for ${minutes(load.cpuHighFor)}; ` +
          `heaviest here: ${list.join(", ")}.`
        if (!send(agent.id, text)) continue
        this.told.add(agent.id)
        sent.push(agent.id)
      }
    }
    return sent
  }

  /** Forgets the strain, as when no agent is left to tell. */
  reset(): void {
    this.told.clear()
  }
}
