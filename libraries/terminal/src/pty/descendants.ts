import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { promisify } from "node:util"

/** A process as one listing shows it, on Linux and macOS. */
export type Listed = {
  readonly pid: number
  readonly parent: number
  readonly group: number
  /** The foreground group of its terminal; 0 or less with none. */
  readonly foreground: number
  /**
   * Its start, compared whole and never read: Linux's in clock ticks since boot, macOS's
   * `lstart`, to the second. With its pid, it names one process.
   */
  readonly started: string
  readonly zombie: boolean
}

/** A process followed past a hangup. */
export type Followed = Pick<Listed, "pid" | "started">

/** Every process now; undefined where they can't be listed, as on Windows. */
export type Listing = () => Promise<readonly Listed[] | undefined>

/**
 * How long a listing may take, in milliseconds: well past `ps` on a busy three-core Mac, 112 ms
 * at most (#721). A quit takes two past its bound, with SIGTERM's wait between them, and the
 * runner's engines and store still have to close within the five seconds the app gives it.
 */
export const listMs = 300

/** After `(comm)` in /proc/<pid>/stat, where the state is field 0: the start's field. */
const startField = 19

/** One process from its /proc/<pid>/stat; undefined for what isn't one. */
export const parseStat = (stat: string): Listed | undefined => {
  const end = stat.lastIndexOf(")")
  if (end < 0) return undefined
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  const started = fields[startField]
  const numbers = [stat, fields[1], fields[2], fields[5]].map((field) => Number.parseInt(field!))
  if (started === undefined || !numbers.every(Number.isSafeInteger)) return undefined
  const [pid, parent, group, foreground] = numbers as [number, number, number, number]
  return { pid, parent, group, foreground, started, zombie: /^[ZX]/.test(fields[0]!) }
}

/** `ps -o pid=,ppid=,pgid=,tpgid=,stat=,lstart=` rows; a line that isn't one is left out. */
export const parsePs = (output: string): Listed[] =>
  output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line)
    if (!match) return []
    const [, pid, parent, group, foreground, state, started] = match
    return [
      {
        pid: Number(pid),
        parent: Number(parent),
        group: Number(group),
        foreground: Number(foreground),
        started: started!,
        zombie: state!.startsWith("Z"),
      },
    ]
  })

const listProc: Listing = async () => {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name))
  const stats = await Promise.all(
    pids.map((pid) => readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)),
  )
  return stats.flatMap((stat) => {
    const listed = stat === undefined ? undefined : parseStat(stat)
    return listed ? [listed] : []
  })
}

// macOS has no /proc. The C locale keeps `lstart` one form, compared as it is.
const listPs =
  (limitMs: number): Listing =>
  async () => {
    const { stdout } = await promisify(execFile)(
      "ps",
      ["-axo", "pid=,ppid=,pgid=,tpgid=,stat=,lstart="],
      {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: "C" },
        maxBuffer: 64 * 1024 * 1024,
        timeout: limitMs,
      },
    )
    return parsePs(stdout)
  }

const listFor = (platform: NodeJS.Platform, limitMs: number): Listing | undefined =>
  platform === "linux" ? listProc : platform === "darwin" ? listPs(limitMs) : undefined

/** `list`, as none past `limitMs`, whatever it is stuck on. */
export const boundedListing = (list: Listing, limitMs: number): Listing => {
  return async () => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<undefined>((resolve) => {
      timer = setTimeout(resolve, limitMs, undefined)
    })
    return Promise.race([list(), late]).finally(() => clearTimeout(timer))
  }
}

/**
 * Listings shared by all who ask at about the same moment: a shutdown ending thirty
 * terminals takes one before their hangups, one as their bound passes, and one for SIGKILL.
 */
export const sharedListing = (list: Listing, sharedMs = 50): Listing => {
  let current: { readonly rows: ReturnType<Listing>; settledAt?: number } | undefined
  return () => {
    const { settledAt } = current ?? {}
    const fresh = current && (settledAt === undefined || Date.now() - settledAt < sharedMs)
    if (current && fresh) return current.rows
    const rows = list().catch(() => undefined)
    const made: { rows: ReturnType<Listing>; settledAt?: number } = { rows }
    current = made
    void rows.then(() => {
      made.settledAt = Date.now()
    })
    return rows
  }
}

/** This system's processes, shared; none on Windows, which ends trees by the relay. */
export const processListing = (
  platform: NodeJS.Platform = process.platform,
  sharedMs?: number,
  limitMs = listMs,
): Listing => {
  const list = listFor(platform, limitMs)
  return list
    ? sharedListing(boundedListing(list, limitMs), sharedMs)
    : () => Promise.resolve(undefined)
}

/** `seed` and everything under them by parent, each once, in the order found. */
const withBelow = (rows: readonly Listed[], seed: readonly Listed[]): readonly Listed[] => {
  const found = new Map(seed.map((row) => [row.pid, row]))
  for (let grown = true; grown;) {
    grown = false
    for (const row of rows)
      if (!found.has(row.pid) && found.has(row.parent)) {
        found.set(row.pid, row)
        grown = true
      }
  }
  return [...found.values()]
}

const live = (rows: readonly Listed[]) => rows.filter((row) => !row.zombie && row.pid > 1)

/**
 * What to follow past the hangup of the terminal whose shell is `shell`, while `agent` runs
 * in its foreground: that foreground group and everything under it by parent, as an agent's
 * tools are, each in a group of its own. Undefined where anything else holds the foreground,
 * such as the person's own program once the agent has left, or the shell at its prompt.
 *
 * What the shell started beside the agent isn't under it, so it stays, as a `nohup` or a
 * `tmux` the person left running. So does what left the tree before now in a group of its own,
 * as a daemon that forked twice: its parent is no longer the one that started it. What shares
 * the foreground group goes with it, however it got there, as nothing tells them apart; and
 * with an agent that took the shell's place by `exec`, all the shell started is under it.
 */
export const agentProcesses = (
  rows: readonly Listed[],
  shell: number,
  agent: number,
): readonly Followed[] | undefined => {
  const foreground = rows.find((row) => row.pid === shell)?.foreground
  const lead = rows.find((row) => row.pid === agent)
  // The shell itself holds it at its prompt, unless it became the agent (`exec codex`).
  if (!foreground || foreground <= 1 || (foreground === shell && agent !== shell)) return undefined
  if (lead?.group !== foreground || lead.zombie) return undefined
  const members = live(rows).filter((row) => row.group === foreground)
  return live(withBelow(rows, members)).map(({ pid, started }) => ({ pid, started }))
}

/**
 * Where `agent` runs in the terminal whose shell is `shell`, as one listing shows it:
 * `chain` the processes from the shell's own child down to the agent (a wrapper such as
 * `npx` is in it), `foreground` whether the agent's group holds the terminal's foreground
 * (not the shell's prompt, not tmux's or a detached client's), and `below` every live process
 * under the agent, by parent, its tools and servers. Undefined unless the agent is a live
 * descendant of the shell.
 */
export type Placement = {
  readonly chain: readonly number[]
  readonly foreground: boolean
  readonly below: readonly Followed[]
  /** Each process of `below` that has a parent in it, by `processKey`, with its parent's. */
  readonly lineage: ReadonlyMap<string, string>
}

/** A process by its pid and start, which together name one for as long as it lives. */
export const processKey = ({ pid, started }: Followed): string => `${pid}:${started}`

export const placement = (
  rows: readonly Listed[],
  shell: number,
  agent: number,
): Placement | undefined => {
  const byPid = new Map(rows.map((row) => [row.pid, row]))
  const lead = byPid.get(agent)
  const root = byPid.get(shell)
  if (!lead || !root || lead.zombie || root.zombie || agent === shell) return undefined
  const chain: number[] = []
  for (
    let at: Listed | undefined = lead;
    at && chain.length <= rows.length;
    at = byPid.get(at.parent)
  ) {
    if (at.pid === shell) {
      const foreground =
        root.foreground > 1 && root.foreground !== shell && lead.group === root.foreground
      const below = live(withBelow(rows, [lead])).filter((row) => row.pid !== agent)
      const inside = new Map(below.map((one) => [one.pid, one]))
      const lineage = new Map<string, string>()
      for (const one of below) {
        const parent = inside.get(one.parent)
        if (parent) lineage.set(processKey(one), processKey(parent))
      }
      return {
        chain: chain.toReversed(),
        foreground,
        lineage,
        below: below.map(({ pid, started }) => ({ pid, started })),
      }
    }
    if (at.pid <= 1) return undefined
    chain.push(at.pid)
  }
  return undefined
}

/**
 * Which of `followed` still run, by pid and start, so never a process that has since been
 * given a pid; with what is under each, and what shares a group with one, whose group is
 * sure to be its own as long as it runs. A group is never signalled as such.
 */
export const stillRunning = (
  rows: readonly Listed[],
  followed: readonly Followed[],
): readonly Followed[] => {
  const same = live(rows).filter((row) =>
    followed.some(({ pid, started }) => pid === row.pid && started === row.started),
  )
  const groups = new Set(same.map((row) => row.group))
  const seed = live(rows).filter((row) => groups.has(row.group) || same.includes(row))
  return live(withBelow(rows, seed)).map(({ pid, started }) => ({ pid, started }))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const pollMs = 50

/** How long what ignored the hangup has after SIGTERM before SIGKILL, in milliseconds. */
export const termGraceMs = 500

/** Whether `pid` answers: past its exit, or another's by now. */
const answers = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

const signalEach = (ones: readonly Followed[], signal: NodeJS.Signals): void => {
  for (const { pid } of ones)
    try {
      process.kill(pid, signal)
    } catch {
      // Gone meanwhile.
    }
}

// Said, as what is left then runs on: nothing can tell that these pids are still the same.
const unlisted = (ones: readonly Followed[]): void => {
  console.error(
    "Listing the processes failed, so these of a closed terminal's agent were not ended:",
    ones.map(({ pid }) => pid).join(", "),
  )
}

/**
 * Waits for `followed` to end by itself until `until()`, which is asked anew each time, as a
 * quit may bring it forward; then ends what is left. SIGTERM, then SIGKILL `termGraceMs` on,
 * each by its pid, and only after a listing has shown that pid is still the same process:
 * where listing fails, nothing is signalled.
 */
export const endFollowed = async (
  followed: readonly Followed[],
  until: () => number,
  list: Listing,
): Promise<void> => {
  const running = (ones: readonly Followed[]) => ones.some(({ pid }) => answers(pid))
  while (running(followed) && Date.now() < until())
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await sleep(Math.max(1, Math.min(pollMs, until() - Date.now())))
  if (!running(followed)) return
  const before = await list()
  if (!before) return unlisted(followed)
  const left = stillRunning(before, followed)
  if (left.length === 0) return
  signalEach(left, "SIGTERM")
  // A stopped process acts on neither until it runs again.
  signalEach(left, "SIGCONT")
  const by = Date.now() + termGraceMs
  while (running(left) && Date.now() < by)
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await sleep(pollMs)
  if (!running(left)) return
  const after = await list()
  if (!after) return unlisted(left)
  const stubborn = stillRunning(after, left)
  signalEach(stubborn, "SIGKILL")
}
