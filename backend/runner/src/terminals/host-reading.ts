import { execFile } from "node:child_process"
import { readdir, readFile } from "node:fs/promises"
import { cpus, freemem, totalmem } from "node:os"
import { basename } from "node:path"
import { promisify } from "node:util"

import type { ProcessTrees } from "@novadeck/terminal/pty"

import type { HostReading, TerminalCpu } from "./host-load.js"

/** A process as one listing of the system shows it, with the processor time it used. */
export type ProcessRow = {
  readonly pid: number
  readonly parent: number
  readonly name: string
  /** What it used itself, in milliseconds. */
  readonly selfMs: number
  /**
   * What it and the children it has waited for used: Linux keeps the latter with the
   * parent, so a short-lived child (a compiler run) isn't lost between two readings.
   */
  readonly totalMs: number
}

/** Linux counts processor time in ticks of this many a second (`sysconf(_SC_CLK_TCK)`: 100 on every Linux Node runs on). */
const ticksPerSecond = 100

const fromTicks = (ticks: number): number => (ticks * 1000) / ticksPerSecond

/** One process from its /proc/<pid>/stat; undefined for what isn't one. */
export const parseProcStat = (stat: string): ProcessRow | undefined => {
  const open = stat.indexOf("(")
  const close = stat.lastIndexOf(")")
  if (open < 0 || close < open) return undefined
  // After `(comm)`: state, ppid, ... utime (field 14 of the file), stime, cutime, cstime.
  const fields = stat
    .slice(close + 2)
    .trim()
    .split(/\s+/)
  const numbers = [stat, fields[1], fields[11], fields[12], fields[13], fields[14]].map((field) =>
    Number.parseInt(field!),
  )
  if (!numbers.every(Number.isSafeInteger)) return undefined
  const [pid, parent, user, system, childUser, childSystem] = numbers as [
    number,
    number,
    number,
    number,
    number,
    number,
  ]
  return {
    pid,
    parent,
    name: stat.slice(open + 1, close),
    selfMs: fromTicks(user + system),
    totalMs: fromTicks(user + system + Math.max(0, childUser) + Math.max(0, childSystem)),
  }
}

/** `ps`' cumulative CPU time, `[[dd-]hh:]mm:ss[.cc]`, in milliseconds; undefined if it isn't one. */
export const parseCpuTime = (time: string): number | undefined => {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/.exec(time)
  if (!match) return undefined
  const [, days = "0", hours = "0", minutes, seconds] = match
  return (
    (((Number(days) * 24 + Number(hours)) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000
  )
}

/** `ps -axo pid=,ppid=,time=,comm=` rows (`comm` last, as a path may hold spaces). */
export const parsePs = (output: string): ProcessRow[] =>
  output.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line)
    const ms = match ? parseCpuTime(match[3]!) : undefined
    if (!match || ms === undefined) return []
    return [
      {
        pid: Number(match[1]),
        parent: Number(match[2]),
        name: basename(match[4]!),
        selfMs: ms,
        totalMs: ms,
      },
    ]
  })

const listProc = async (): Promise<ProcessRow[]> => {
  const pids = (await readdir("/proc")).filter((name) => /^\d+$/.test(name))
  const stats = await Promise.all(
    pids.map((pid) => readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined)),
  )
  return stats.flatMap((stat) => {
    const row = stat === undefined ? undefined : parseProcStat(stat)
    return row ? [row] : []
  })
}

/**
 * What `ps` is run with: `-S` adds the time of the children a process has waited for to its own,
 * as Linux's cutime does, so a short-lived child (a compiler run) isn't lost between two
 * readings. The column reads as without it, so a row's own time is then its total.
 */
export const psArguments = ["-S", "-axo", "pid=,ppid=,time=,comm="] as const

const listPs = async (): Promise<ProcessRow[]> => {
  const { stdout } = await promisify(execFile)("ps", psArguments, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 64 * 1024 * 1024,
    timeout: 3_000,
  })
  return parsePs(stdout)
}

/** The processes of the system with their processor time; undefined where they can't be read. */
const listing = async (platform: NodeJS.Platform): Promise<ProcessRow[] | undefined> => {
  try {
    return platform === "linux" ? await listProc() : await listPs()
  } catch {
    return undefined
  }
}

/** `shell` and every process under it by parent, as one terminal's tree. */
export const treeCpu = (rows: readonly ProcessRow[], shell: number): TerminalCpu | undefined => {
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of rows) byParent.set(row.parent, [...(byParent.get(row.parent) ?? []), row])
  const found = new Map<number, ProcessRow>()
  const root = rows.find((row) => row.pid === shell)
  if (!root) return undefined
  const walk = [root]
  for (let row = walk.pop(); row; row = walk.pop()) {
    if (found.has(row.pid)) continue
    found.set(row.pid, row)
    walk.push(...(byParent.get(row.pid) ?? []).filter((child) => child.pid > 1))
  }
  const tree = [...found.values()]
  return {
    ms: tree.reduce((sum, row) => sum + row.totalMs, 0),
    programs: tree.map(({ pid, name, selfMs }) => ({ pid, name, ms: selfMs })),
  }
}

/**
 * What each terminal's process tree has used so far, by terminal id, given each terminal's
 * shell pid. Linux reads /proc, macOS `ps` (both once for every terminal), Windows asks the
 * relay for each tree (one run for all); a terminal whose tree can't be read is left out,
 * and nothing is said where none can.
 */
export type Processes = (
  shells: ReadonlyMap<string, number>,
) => Promise<ReadonlyMap<string, TerminalCpu>>

export const readProcesses =
  (platform: NodeJS.Platform, trees: () => Pick<ProcessTrees, "read">): Processes =>
  async (shells) => {
    const found = new Map<string, TerminalCpu>()
    if (platform === "win32") {
      await Promise.all(
        [...shells].map(async ([id, pid]) => {
          const tree = await trees()
            .read(pid)
            .catch(() => undefined)
          // A relay that doesn't tell processor time (an older one) tells nothing of it.
          if (!tree?.some((member) => member.cpuMs !== undefined)) return
          found.set(id, {
            ms: tree.reduce((sum, member) => sum + (member.cpuMs ?? 0), 0),
            programs: tree.map(({ pid: each, name, cpuMs }) => ({
              pid: each,
              name: name ?? "",
              ms: cpuMs ?? 0,
            })),
          })
        }),
      )
      return found
    }
    const rows = await listing(platform)
    if (!rows) return found
    for (const [id, pid] of shells) {
      const tree = treeCpu(rows, pid)
      if (tree) found.set(id, tree)
    }
    return found
  }

/** The memory in use, in percent, from /proc/meminfo's text; undefined if it isn't there. */
export const parseMeminfo = (text: string): number | undefined => {
  const kilobytes = (name: string): number | undefined => {
    const match = new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, "m").exec(text)
    return match ? Number(match[1]) : undefined
  }
  const total = kilobytes("MemTotal")
  const available = kilobytes("MemAvailable")
  if (!total || available === undefined) return undefined
  return ((total - available) / total) * 100
}

/**
 * The memory in use on macOS, in percent of `total` bytes, from `vm_stat`'s text: what is not
 * free, inactive, speculative or purgeable (which the system gives back on demand) is in use.
 */
export const parseVmStat = (text: string, total: number): number | undefined => {
  const size = /page size of (\d+) bytes/.exec(text)
  if (!size || total <= 0) return undefined
  const pages = (name: string): number => {
    const match = new RegExp(`^${name}:\\s+(\\d+)`, "m").exec(text)
    return match ? Number(match[1]) : 0
  }
  const available =
    (pages("Pages free") +
      pages("Pages inactive") +
      pages("Pages speculative") +
      pages("Pages purgeable")) *
    Number(size[1])
  return Math.min(100, Math.max(0, (1 - available / total) * 100))
}

const memory = async (platform: NodeJS.Platform): Promise<number | undefined> => {
  try {
    if (platform === "linux") return parseMeminfo(await readFile("/proc/meminfo", "utf8"))
    if (platform === "darwin") {
      const { stdout } = await promisify(execFile)("vm_stat", [], {
        encoding: "utf8",
        timeout: 3_000,
      })
      return parseVmStat(stdout, totalmem())
    }
    return ((totalmem() - freemem()) / totalmem()) * 100
  } catch {
    return undefined
  }
}

/** The host's processor time and memory now, from the system. */
export const readHost = async (platform: NodeJS.Platform): Promise<HostReading> => {
  let busyMs = 0
  let totalMs = 0
  for (const { times } of cpus()) {
    const busy = times.user + times.nice + times.sys + times.irq
    busyMs += busy
    totalMs += busy + times.idle
  }
  return { at: Date.now(), busyMs, totalMs, memoryPercent: await memory(platform) }
}
