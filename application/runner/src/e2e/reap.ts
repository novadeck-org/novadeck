import { execFile } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readdirSync, readFileSync, readlinkSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { relayPath } from "@novadeck/relay"

import { anyRunning, taskkillTree, Trees } from "../terminals/trees.js"
import type { Sandbox } from "./sandbox.js"

type Scope = Pick<Sandbox, "root" | "home" | "started">

/**
 * A process of the sandbox: its command's name, its start, which with its pid tells it
 * apart from a later process given the same pid, and whether it was stopped, as by job
 * control, when last read (never on Windows, which has no such state).
 */
type Process = {
  readonly pid: number
  readonly comm: string
  readonly start: number
  readonly stopped: boolean
  /** Where the system is asked, how its recorded parent stands, for a leftover's report. */
  readonly parent?: string
}

/** How a platform finds the sandbox's processes, tells whether one still runs, and ends it. */
type Table = {
  /** The processes of the sandbox now. */
  readonly list: (scope: Scope) => Promise<readonly Process[]>
  /** Whether the process may still run, cheaply enough to ask again and again. */
  readonly alive: (scope: Scope, one: Process) => boolean
  /** Those of them still the same processes of the sandbox, as they are now. */
  readonly current: (scope: Scope, found: readonly Process[]) => Promise<readonly Process[]>
  /** Asks the process to end, or with `forcibly` ends it and, where it can, what it started. */
  readonly end: (one: Process, forcibly: boolean) => Promise<void>
}

/**
 * The process with the pid, should it belong to the sandbox. It reads the process's
 * `stat` for its state and start, and passes over a zombie and any process that started
 * before the sandbox. Only for the rest does it read the target of `cwd`, then, should
 * that not be inside the sandbox, `environ`, searched only for `HOME=<sandbox home>`
 * and neither kept nor printed, and last its `comm`.
 */
const member = (sandbox: Scope, pid: number): Process | undefined => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8")
    // Fields after the command, which is in parentheses and may hold anything: the state
    // is field 3, the start field 22.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
    const start = Number(fields[19])
    if (fields[0] === "Z" || !(start >= sandbox.started)) return undefined
    const cwd = readlinkSync(`/proc/${pid}/cwd`)
    const inside = cwd === sandbox.root || cwd.startsWith(`${sandbox.root}/`)
    if (
      !inside &&
      !readFileSync(`/proc/${pid}/environ`, "latin1").split("\0").includes(`HOME=${sandbox.home}`)
    )
      return undefined
    return {
      pid,
      start,
      comm: readFileSync(`/proc/${pid}/comm`, "utf8").trim(),
      // T is stopped by a signal, t by a tracer.
      stopped: fields[0] === "T" || fields[0] === "t",
    }
  } catch {
    // Gone, or another user's, which a sandbox's process never is.
    return undefined
  }
}

// Linux, from /proc, signalling a process only should it still be the one found.
const linux: Table = {
  list: async (sandbox) =>
    readdirSync("/proc")
      .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
      .flatMap((name) => member(sandbox, Number(name)) ?? []),
  alive: (sandbox, one) => member(sandbox, one.pid)?.start === one.start,
  current: async (sandbox, found) =>
    found.flatMap((one) => {
      const now = member(sandbox, one.pid)
      return now?.start === one.start ? [now] : []
    }),
  end: async (one, forcibly) => {
    try {
      process.kill(one.pid, forcibly ? "SIGKILL" : "SIGTERM")
    } catch {
      // Gone meanwhile.
    }
  },
}

// The lister (reap-lister.cs), compiled once by its source into the system's temporary
// folder, with the C# compiler every Windows has in its .NET Framework: one quick process
// a listing, where starting PowerShell for each took most of a minute's test on a CI
// runner. Each compiled program is named by its own hash too, checked before it is run:
// one there that isn't what its name says, as a half-written one, is passed over, and a
// run that compiles another, as two at once may, never makes one already there wrong.
const lister = readFileSync(new URL("reap-lister.cs", import.meta.url), "utf8")
const listerName = `novadeck-e2e-reap-${createHash("sha256").update(lister).digest("hex").slice(0, 16)}`

const hashOf = (file: string): string =>
  createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16)

// A program of this source there, as its name says, if any.
const intact = (): string | undefined => {
  const named = new RegExp(`^${listerName}-([0-9a-f]{16})\\.exe$`)
  for (const name of readdirSync(tmpdir())) {
    const hash = named.exec(name)?.[1]
    if (!hash) continue
    try {
      if (hashOf(join(tmpdir(), name)) === hash) return join(tmpdir(), name)
    } catch {
      // Gone meanwhile, or not readable: another.
    }
  }
  return undefined
}

// Removes the listers of other sources, as earlier versions of this one compiled: a run of
// one may still use it, which leaves it there.
const sweep = (): void => {
  const others = /^novadeck-e2e-reap-[0-9a-f]{16}(-[0-9a-f]{16})?\.exe$/
  for (const name of readdirSync(tmpdir()))
    if (others.test(name) && !name.startsWith(`${listerName}-`))
      try {
        rmSync(join(tmpdir(), name), { force: true })
      } catch {
        // In use.
      }
}

// Why the lister can't be run, with what usually causes it on a developer's machine: a
// program that reads every process's memory is what an antivirus quarantines.
const blocked = (program: string, cause: unknown): Error =>
  new Error(
    `The e2e suite's process lister (${program}) could not run: ${
      cause instanceof Error ? cause.message : String(cause)
    }. Windows Defender or another antivirus may have quarantined it, as it reads other processes' memory; allow it, or exclude ${join(tmpdir(), "novadeck-e2e-reap-*.exe")}, and run again.`,
    { cause },
  )

let compiled: Promise<string> | undefined
const compiledLister = (): Promise<string> =>
  (compiled ??= (async () => {
    const there = intact()
    if (there) return there
    const root = process.env.SystemRoot ?? "C:\\Windows"
    const csc = join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe")
    const staging = join(tmpdir(), `${listerName}.${randomBytes(6).toString("hex")}`)
    writeFileSync(`${staging}.cs`, lister)
    try {
      await promisify(execFile)(
        csc,
        ["/nologo", "/target:exe", "/optimize", `/out:${staging}.exe`, `${staging}.cs`],
        { windowsHide: true, timeout: 120_000 },
      )
      const program = join(tmpdir(), `${listerName}-${hashOf(`${staging}.exe`)}.exe`)
      renameSync(`${staging}.exe`, program)
      sweep()
      return program
    } catch (cause) {
      compiled = undefined
      throw blocked(join(tmpdir(), `${listerName}-*.exe`), cause)
    } finally {
      rmSync(`${staging}.cs`, { force: true })
      rmSync(`${staging}.exe`, { force: true })
    }
  })())

const windowsList = async (sandbox: Scope): Promise<readonly Process[]> => {
  const program = await compiledLister()
  let stdout: string
  try {
    ;({ stdout } = await promisify(execFile)(
      program,
      [String(sandbox.started), sandbox.root, sandbox.home, String(process.pid)],
      { windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
    ))
  } catch (cause) {
    // One removed or changed since is compiled again next time; one still there, as one an
    // antivirus blocks but leaves, is tried again, and fails the same way, naming it.
    compiled = undefined
    throw blocked(program, cause)
  }
  const rows = JSON.parse(stdout) as {
    readonly pid: number
    readonly comm: string
    readonly start: number
    readonly parent: string
  }[]
  return rows.map(({ pid, comm, start, parent }) => ({ pid, comm, start, stopped: false, parent }))
}

// The tree a stuck process left, read and ended through Novadeck's relay, as the e2e suite
// builds it.
const trees = new Trees(async () => relayPath)

const windows: Table = {
  list: windowsList,
  // A pid alone, between listings: a process found a moment before isn't replaced by
  // another of the same pid that soon; `current` checks its start before it is ended.
  alive: (_sandbox, one) => {
    try {
      process.kill(one.pid, 0)
      return true
    } catch {
      return false
    }
  },
  current: async (sandbox, found) => {
    const now = await windowsList(sandbox)
    return found.filter((one) => now.some((it) => it.pid === one.pid && it.start === one.start))
  },
  // Windows has no signal to ask with: ending one is TerminateProcess, and forcibly it
  // ends what it started too, as the runner's own tree kill does: the tree Novadeck's
  // relay reads, where a process counts as a child only if it started no earlier than its
  // recorded parent, so an unrelated one given an ended parent's pid isn't, and each is
  // ended only as the process it was. Only a tree whose root is the process found, by its
  // start, is ended, and waited for, so nothing of it holds the sandbox's files once
  // `reap` returns.
  end: async (one, forcibly) => {
    if (!forcibly) {
      try {
        process.kill(one.pid)
      } catch {
        // Gone meanwhile.
      }
      return
    }
    const tree = await trees.read(one.pid)
    // Where the relay can't read it, taskkill ends the tree, awaited, as it did before:
    // only the root is checked, just before, by its start.
    if (tree === undefined) return taskkillTree(one.pid).catch(() => {})
    if (tree[0]?.startedAt !== one.start) return
    await trees.end(tree)
    const deadline = Date.now() + 30_000
    while (anyRunning(tree) && Date.now() < deadline)
      // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
      await new Promise((resolve) => setTimeout(resolve, 50))
  },
}

/**
 * Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=,comm=` in the C locale: each process's pid,
 * its parent's and its process group's, state, start (`Thu Oct  9 11:03:47 2026`, local
 * time, to the second) and its command's path, which may hold spaces, named by its last
 * part as Linux's `comm` is. Local time has no zone: in the hour the clocks go back,
 * one started in its second pass reads an hour early, so may not count as the sandbox's.
 */
export const parseDarwinProcesses = (
  output: string,
): readonly (Process & {
  readonly ppid: number
  readonly pgid: number
  readonly zombie: boolean
})[] =>
  output.split("\n").flatMap((line) => {
    const match =
      /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d+\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+)$/.exec(
        line,
      )
    if (!match) return []
    const start = new Date(match[5]!.replace(/\s+/g, " ")).getTime()
    if (Number.isNaN(start)) return []
    return [
      {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        comm: match[6]!.trim().split("/").at(-1)!,
        start,
        // Z is a zombie, which `darwinList` passes over; T is stopped.
        stopped: match[4]!.includes("T"),
        zombie: match[4]!.includes("Z"),
      },
    ]
  })

/**
 * What the program printed. A failure throws, so the reaper fails closed, as Windows'
 * lister does, but for `partial`: `lsof` and `ps` asked about pids exit 1 when one of them
 * has gone, still printing the rest.
 */
const run = async (program: string, args: readonly string[], partial = false): Promise<string> => {
  try {
    const { stdout } = await promisify(execFile)(program, [...args], {
      env: { ...process.env, LC_ALL: "C" },
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    const { code, stdout } = error as { code?: unknown; stdout?: string }
    if (partial && code === 1 && stdout !== undefined) return stdout
    throw new Error(`reap: ${program} ${args.join(" ")} failed`, { cause: error })
  }
}

/**
 * The working folders of the processes, by pid, from one `lsof -Fn` of their `cwd`s: its
 * `p<pid>` lines each followed by the folder's `n<path>`.
 */
export const parseDarwinFolders = (output: string): ReadonlyMap<number, string> => {
  const folders = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) folders.set(pid, line.slice(1))
  }
  return folders
}

/**
 * macOS, which has no /proc: `ps` for the processes, their parents, groups, states and
 * starts, which it gives to the second, so one started in the second the sandbox was made
 * counts; `lsof` for the working folders of those that started since; and for the rest
 * `ps -E`, which shows the environment after the command of the user's own processes,
 * searched only for `HOME=<sandbox home>` and neither kept nor printed. macOS shows none
 * of its own programs' (bash, sleep), so one of those is found by its working folder, or
 * as a child of one found, or in a process group of one found, as a job left running in
 * the background is; never in the tests' own group.
 */
const darwinList = async (sandbox: Scope): Promise<readonly Process[]> => {
  const since = Math.floor(sandbox.started / 1000) * 1000
  const listed = await everyProcess()
  // Found in every listing that worked: one without it worked only in part.
  const ownGroup = listed.find((one) => one.pid === process.pid)?.pgid
  if (ownGroup === undefined) throw new Error("reap: ps listed no process of the tests'")
  const recent = listed.filter(
    (one) => one.pid !== process.pid && !one.zombie && one.start >= since,
  )
  if (recent.length === 0) return []
  const pids = recent.map(({ pid }) => String(pid)).join(",")
  const folders = parseDarwinFolders(
    await run("/usr/sbin/lsof", ["-a", "-d", "cwd", "-Fn", "-p", pids], true),
  )
  const inside = (folder: string | undefined) =>
    folder !== undefined && (folder === sandbox.root || folder.startsWith(`${sandbox.root}/`))
  const outside = recent.filter((one) => !inside(folders.get(one.pid)))
  const members = new Set(
    recent.filter((one) => inside(folders.get(one.pid))).map(({ pid }) => pid),
  )
  if (outside.length > 0) {
    const environments = await run(
      "ps",
      ["-Eww", "-o", "pid=,command=", "-p", outside.map(({ pid }) => String(pid)).join(",")],
      true,
    )
    // Its own variable, which a home with a space in its path still is: the next starts
    // after a space, or the line ends.
    const homed = ` HOME=${sandbox.home}`
    for (const line of environments.split("\n")) {
      const match = /^\s*(\d+)\s(.*)$/.exec(line)
      if (match && (match[2]!.includes(`${homed} `) || match[2]!.endsWith(homed)))
        members.add(Number(match[1]))
    }
  }
  const all = sandboxed(recent, members, ownGroup)
  return recent
    .filter((one) => all.has(one.pid))
    .map(({ pid, comm, start, stopped }) => ({ pid, comm, start, stopped }))
}

/**
 * Those found of the processes, with every one of the processes whose parent is one of
 * them or whose process group holds one of them, until no more join, but never one in
 * `ownGroup`, the tests' own group, which the sandbox's processes have no business in.
 */
export const sandboxed = (
  processes: readonly { readonly pid: number; readonly ppid: number; readonly pgid: number }[],
  found: ReadonlySet<number>,
  ownGroup: number | undefined,
): ReadonlySet<number> => {
  const members = new Set(found)
  for (let grown = true; grown;) {
    grown = false
    const groups = new Set(processes.filter(({ pid }) => members.has(pid)).map(({ pgid }) => pgid))
    for (const one of processes)
      if (
        !members.has(one.pid) &&
        one.pgid !== ownGroup &&
        (members.has(one.ppid) || (one.pgid > 1 && groups.has(one.pgid)))
      ) {
        members.add(one.pid)
        grown = true
      }
  }
  return members
}

/** Every process now, as `ps -ax` lists them; throws should it fail. */
const everyProcess = async () =>
  parseDarwinProcesses(await run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,comm="]))

const darwin: Table = {
  list: darwinList,
  // A pid alone, between listings, as on Windows; `current` checks its start.
  alive: windows.alive,
  // The same processes, each by its pid and start, as they are now: never found again
  // from scratch, as one found through its parent no longer is once that parent has gone.
  current: async (_sandbox, found) => {
    const now = await everyProcess()
    return now
      .filter(
        (it) => !it.zombie && found.some((one) => one.pid === it.pid && one.start === it.start),
      )
      .map(({ pid, comm, start, stopped }) => ({ pid, comm, start, stopped }))
  },
  end: linux.end,
}

const table =
  process.platform === "win32" ? windows : process.platform === "darwin" ? darwin : linux

/** The sandbox's processes now, as `reap` finds them, by pid and command name; none ended. */
export const sandboxProcesses = async (
  sandbox: Scope,
): Promise<readonly { readonly pid: number; readonly comm: string }[]> => table.list(sandbox)

/**
 * The sandbox's processes now, each named as a leftover is, with its recorded parent on
 * Windows; none elsewhere. Taken while a deck still runs, it names the parent a leftover
 * later records as gone, which tells a program started apart from the terminal's shell
 * from one the terminal's tree should have held.
 */
export const census = async (sandbox: Scope): Promise<string[]> =>
  process.platform === "win32" ? (await table.list(sandbox)).map(named) : []

// Waits until none of them is still running or the time is up.
const ended = async (sandbox: Scope, found: readonly Process[], ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (found.some((one) => table.alive(sandbox, one)) && Date.now() < deadline)
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await new Promise((resolve) => setTimeout(resolve, 50))
}

// How a leftover is reported: `claude (123)`, or `claude (123, stopped)` for one that
// could never have exited by itself; on Windows too its recorded parent, `cmd#12 gone`,
// which tells a program the terminal's tree could not reach from one it should have.
const named = (one: Process): string =>
  `${one.comm} (${one.pid}${one.stopped ? ", stopped" : ""}${one.parent ? `, parent ${one.parent}` : ""})`

/**
 * Ends the processes still running in the sandbox once its deck has closed: those that
 * started after it was made and whose working folder is inside it, or whose HOME is its
 * home. A harness the deck's hangup reached may take a moment to exit, so each gets
 * three seconds to end by itself; one still running then is asked to end (SIGTERM; on
 * Windows, which can't ask, ended), then ended forcibly (SIGKILL; on Windows with what it
 * started) if it outlives two seconds more, each only should it still be the process
 * found. As ending one may leave a child behind, it looks again, up to five times, until
 * it finds none it hasn't seen. Returns those that had to be ended, by their commands'
 * names and pids, each marked `stopped` should it have been, as a leak the test reports.
 * On Linux it reads /proc; on Windows it asks the system through a lister of its own;
 * on macOS it asks `ps` and `lsof`.
 */
export const reap = async (sandbox: Scope): Promise<string[]> => {
  const seen = new Set<string>()
  const leftovers: string[] = []
  for (let round = 0; round < 5; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each round looks again after the last.
    const found = (await table.list(sandbox)).filter((one) => !seen.has(`${one.pid}:${one.start}`))
    if (found.length === 0) break
    for (const one of found) seen.add(`${one.pid}:${one.start}`)
    // eslint-disable-next-line no-await-in-loop -- Each round waits on the one found.
    await ended(sandbox, found, 3000)
    // Each as it is now, so one stopped while it was waited for is named stopped.
    // eslint-disable-next-line no-await-in-loop -- As above.
    const leftover = await table.current(sandbox, found)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await Promise.all(leftover.map((one) => table.end(one, false)))
    // eslint-disable-next-line no-await-in-loop -- As above.
    await ended(sandbox, leftover, 2000)
    // eslint-disable-next-line no-await-in-loop -- As above.
    const holding = await table.current(sandbox, leftover)
    // eslint-disable-next-line no-await-in-loop -- As above.
    await Promise.all(holding.map((one) => table.end(one, true)))
    leftovers.push(...leftover.map(named))
  }
  return leftovers
}
