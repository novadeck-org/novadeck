import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { pidRunning, signal, type Process, type Scope, type Table } from "./process.js"

/** A process as `ps` lists it on macOS: with its parent, its group, and whether a zombie. */
type Listed = Process & {
  readonly ppid: number
  readonly pgid: number
  readonly zombie: boolean
}

/**
 * Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=,comm=` in the C locale: each process's pid,
 * its parent's and its process group's, state, start (`Thu Oct  9 11:03:47 2026`, local
 * time, to the second) and its command's path, which may hold spaces, named by its last
 * part as Linux's `comm` is. Local time has no zone: in the hour the clocks go back,
 * one started in its second pass reads an hour early, so may not count as the sandbox's.
 */
export const parseProcesses = (output: string): readonly Listed[] =>
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
        // Z is a zombie, which `list` passes over; T is stopped.
        stopped: match[4]!.includes("T"),
        zombie: match[4]!.includes("Z"),
      },
    ]
  })

/**
 * The working folders of the processes, by pid, from one `lsof -Fn` of their `cwd`s: its
 * `p<pid>` lines each followed by the folder's `n<path>`.
 */
export const parseFolders = (output: string): ReadonlyMap<number, string> => {
  const folders = new Map<number, string>()
  let pid: number | undefined
  for (const line of output.split("\n")) {
    if (line.startsWith("p")) pid = Number(line.slice(1))
    else if (line.startsWith("n") && pid !== undefined) folders.set(pid, line.slice(1))
  }
  return folders
}

/**
 * Those found of the processes, with every one of the processes whose parent is one of
 * them or whose process group holds one of them, until no more join, but never one in
 * `ownGroup`, the caller's own group, which the sandbox's processes have no business in.
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

/** Every process now, as `ps -ax` lists them; throws should it fail. */
const everyProcess = async (): Promise<readonly Listed[]> =>
  parseProcesses(await run("ps", ["-axww", "-o", "pid=,ppid=,pgid=,stat=,lstart=,comm="]))

// The process alone, as the table gives it.
const asProcess = ({ pid, comm, start, stopped }: Listed): Process => ({
  pid,
  comm,
  start,
  stopped,
})

/**
 * The sandbox's processes. macOS has no /proc: `ps` for the processes, their parents,
 * groups, states and starts, which it gives to the second, so one started in the second
 * the sandbox was made counts; `lsof` for the working folders of those that started since;
 * and for the rest `ps -E`, which shows the environment after the command of the user's
 * own processes, searched only for `HOME=<sandbox home>` and neither kept nor printed.
 * macOS shows none of its own programs' (bash, sleep), so one of those is found by its
 * working folder, or as a child of one found, or in a process group of one found, as a job
 * left running in the background is; never in the caller's own group.
 */
const list = async (sandbox: Scope): Promise<readonly Process[]> => {
  const since = Math.floor(sandbox.started / 1000) * 1000
  const listed = await everyProcess()
  // Found in every listing that worked: one without it worked only in part.
  const ownGroup = listed.find((one) => one.pid === process.pid)?.pgid
  if (ownGroup === undefined) throw new Error("reap: ps listed no process of the caller's")
  const recent = listed.filter(
    (one) => one.pid !== process.pid && !one.zombie && one.start >= since,
  )
  if (recent.length === 0) return []
  const pids = recent.map(({ pid }) => String(pid)).join(",")
  const folders = parseFolders(
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
  return recent.filter((one) => all.has(one.pid)).map(asProcess)
}

/** macOS, from `ps` and `lsof`, signalling a process only should it still be the one found. */
export const darwin: Table = {
  list,
  // A pid alone, between listings, as on Windows; `current` checks its start.
  alive: (_sandbox, one) => pidRunning(one.pid),
  // The same processes, each by its pid and start, as they are now: never found again
  // from scratch, as one found through its parent no longer is once that parent has gone.
  current: async (_sandbox, found) =>
    (await everyProcess())
      .filter(
        (it) => !it.zombie && found.some((one) => one.pid === it.pid && one.start === it.start),
      )
      .map(asProcess),
  end: signal,
}
