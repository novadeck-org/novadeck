import { execFile } from "node:child_process"
import { readFileSync } from "node:fs"
import { basename } from "node:path"
import { promisify } from "node:util"

import type { ForegroundProcess } from "@novadeck/protocol"
import type { IPty } from "node-pty"

// The protocol's bounds for a reported process.
const nameChars = 256
const argCount = 64
const argChars = 4096

type ProcessStat = { pgrp: number; tty: number; tpgid: number }

// /proc/<pid>/stat puts the command in parentheses; it may itself contain spaces or ')'.
export const parseProcessStat = (stat: string): ProcessStat | null => {
  const end = stat.lastIndexOf(")")
  if (end < 0 || stat[end + 1] !== " ") return null
  const fields = stat
    .slice(end + 2)
    .trim()
    .split(/\s+/)
  const pgrp = Number(fields[2])
  const tty = Number(fields[4])
  const tpgid = Number(fields[5])
  if (!Number.isSafeInteger(pgrp) || !Number.isSafeInteger(tty) || !Number.isSafeInteger(tpgid))
    return null
  return { pgrp, tty, tpgid }
}

// /proc/<pid>/cmdline ends each argument with a NUL. A process that retitles itself, as
// Node does for `process.title`, pads its old argument space with NULs, which would read
// as empty arguments, so trailing empty ones go. Truncated to what the protocol takes.
export const parseCommandLine = (cmdline: Buffer): string[] => {
  const args = cmdline.toString("utf8").split("\0")
  while (args.at(-1) === "") args.pop()
  return args.slice(0, argCount).map((arg) => arg.slice(0, argChars))
}

type Group = { readonly id: number; readonly tty: number }

// The foreground process group on the shell's terminal, from one small read.
const foregroundGroup = (shellPid: number): Group | null => {
  const shell = parseProcessStat(readFileSync(`/proc/${shellPid}/stat`, "utf8"))
  if (!shell || shell.tty === 0 || shell.tpgid <= 0) return null
  return { id: shell.tpgid, tty: shell.tty }
}

// Only the group's leader speaks for it, never a descendant, and only while it still
// leads that group on the same terminal.
const leaderArgv = (group: Group): string[] | null => {
  const leader = parseProcessStat(readFileSync(`/proc/${group.id}/stat`, "utf8"))
  if (!leader || leader.pgrp !== group.id || leader.tty !== group.tty) return null
  return parseCommandLine(readFileSync(`/proc/${group.id}/cmdline`))
}

/**
 * The process group holding the shell's terminal's foreground: the shell's own at its
 * prompt, a program's while it runs. Undefined where the platform does not tell, as on
 * Windows, or once the shell is gone.
 */
export const terminalForeground = async (shellPid: number): Promise<number | undefined> => {
  try {
    if (process.platform === "linux") {
      const shell = parseProcessStat(readFileSync(`/proc/${shellPid}/stat`, "utf8"))
      return shell && shell.tpgid > 0 ? shell.tpgid : undefined
    }
    // macOS has no /proc; ps reads the same field, off the event loop.
    if (process.platform === "darwin") {
      const { stdout } = await promisify(execFile)("ps", ["-o", "tpgid=", "-p", String(shellPid)], {
        encoding: "utf8",
        timeout: 2_000,
      })
      const group = Number(stdout.trim())
      return Number.isSafeInteger(group) && group > 0 ? group : undefined
    }
  } catch {
    // The shell may be gone, or ps unavailable.
  }
  return undefined
}

/**
 * The process group a process belongs to; undefined where the platform doesn't tell, as
 * on Windows, or once it is gone.
 */
export const processGroup = async (pid: number): Promise<number | undefined> => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === "linux") {
      const stat = parseProcessStat(readFileSync(`/proc/${pid}/stat`, "utf8"))
      return stat && stat.pgrp > 0 ? stat.pgrp : undefined
    }
    if (process.platform === "darwin") {
      const { stdout } = await promisify(execFile)("ps", ["-o", "pgid=", "-p", String(pid)], {
        encoding: "utf8",
        timeout: 2_000,
      })
      const group = Number(stdout.trim())
      return Number.isSafeInteger(group) && group > 0 ? group : undefined
    }
  } catch {
    // Gone, or ps unavailable.
  }
  return undefined
}

/** Whether the shell itself holds its terminal's foreground, as at its prompt. */
export const shellInForeground = async (shellPid: number): Promise<boolean | undefined> => {
  const group = await terminalForeground(shellPid)
  return group === undefined ? undefined : group === shellPid
}

/** A sample of a terminal's foreground, kept so the next one can reuse its `argv`. */
export type Foreground = {
  readonly process: ForegroundProcess | null
  readonly group: number | null
}

/**
 * The terminal's foreground process. node-pty names it from the group leader's argv[0],
 * so a Node CLI shows as "node"; on Linux the leader's command line tells scripts apart.
 * That is read again only once the group or name changes, keeping a sample cheap.
 * Windows reports no such process, and node-pty's answer there is the terminal type, so
 * it counts as unknown.
 */
export const sampleForeground = (
  child: Pick<IPty, "pid" | "process">,
  last: Foreground | undefined,
): Foreground => {
  if (process.platform === "win32") return { process: null, group: null }
  let name: string
  try {
    name = basename(child.process).slice(0, nameChars)
  } catch {
    return { process: null, group: null }
  }
  if (!name) return { process: null, group: null }
  if (process.platform !== "linux") return { process: { name, argv: null }, group: null }
  try {
    const group = foregroundGroup(child.pid)
    const id = group?.id ?? null
    if (last && last.group === id && last.process?.name === name) return last
    return { process: { name, argv: group && leaderArgv(group) }, group: id }
  } catch {
    // The group can exit between reads; keep node-pty's name and look again next time.
    return { process: { name, argv: null }, group: null }
  }
}
