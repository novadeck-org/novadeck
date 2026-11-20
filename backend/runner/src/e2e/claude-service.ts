import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { promisify } from "node:util"

import { readLock } from "@novadeck/harness-claude/daemon"
import {
  endFollowed,
  processListing,
  sameProcess,
  withBelow,
  type Listed,
  type Member,
} from "@novadeck/terminal/pty"

// Claude Code's background service, which its agents view starts and a terminal's close
// leaves running on purpose (harnesses/claude/src/daemon.ts), is a service of the person's
// login: a logout ends it, as no deck can. A sandbox is a login of its own, so once its deck
// has closed this ends the sandbox's service as the logout would, before the leftover check,
// and names what it ended, by design, apart from the leaks that check reports. Strictly:
// the service only as its lock names it, by pid and start, and of what runs under it only
// its background sessions (`claude bg-pty-host`, `claude bg-spare`) with what they run.
// Anything else, the agent itself included, is left for the leftover check.

/** Ticks between the FILETIME epoch (1601) and the Unix epoch, in milliseconds. */
const filetimeEpochMs = 11_644_473_600_000

/** A Windows FILETIME (100 ns since 1601), as Claude Code writes it, in ms since the epoch. */
export const filetimeMs = (filetime: string): number | undefined =>
  /^\d+$/.test(filetime) ? Number(BigInt(filetime) / 10_000n) - filetimeEpochMs : undefined

/** One of the service's background sessions, by its command line. */
export const isSession = (command: string): boolean =>
  /^claude bg-(?:pty-host|spare)(?:\s|$)/.test(command.trim())

const commandLine = async (pid: number): Promise<string> => {
  if (process.platform === "linux")
    return readFile(`/proc/${pid}/cmdline`, "utf8").then(
      (raw) => raw.split("\0").join(" ").trim(),
      () => "",
    )
  return promisify(execFile)("ps", ["-ww", "-o", "command=", "-p", String(pid)], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  }).then(
    ({ stdout }) => stdout.trim(),
    () => "",
  )
}

const named = (row: Pick<Listed, "pid" | "command">) => `${row.command ?? "?"} (${row.pid})`

/**
 * Ends the background service whose lock is in the Claude Code home `home`, as a logout
 * would, with its background sessions; names what it ended. Nothing where the lock can't be
 * read or no running process is the one it names.
 */
export const endClaudeService = async (
  home: string,
  trees: {
    read(root: number | Member, timeoutMs?: number): Promise<readonly Member[] | undefined>
    end(members: readonly Member[], timeoutMs?: number): Promise<void>
  },
): Promise<string[]> => {
  const lock = await readLock(home)
  if (!lock) return []
  if (process.platform === "win32") {
    const started = lock.startFt === undefined ? undefined : filetimeMs(lock.startFt)
    const tree = started === undefined ? undefined : await trees.read(lock.pid)
    const root = tree?.find((member) => member.pid === lock.pid)
    // Only the very process the lock names, to the millisecond, with what it started.
    if (!tree || root?.startedAt !== started) return []
    await trees.end(tree)
    return tree.map((member) => `${member.name ?? "?"} (${member.pid})`)
  }
  if (lock.start === undefined) return []
  const listing = processListing(process.platform, 0, 5_000)
  const rows = await listing()
  const service = rows?.find((row) =>
    sameProcess(row, { pid: lock.pid, start: lock.start! }, process.platform),
  )
  if (!rows || !service) return []
  // Held still, so it starts no warm session in place of one ended.
  process.kill(service.pid, "SIGSTOP")
  const children = rows.filter((row) => row.parent === service.pid && !row.zombie)
  const commands = await Promise.all(children.map((row) => commandLine(row.pid)))
  const sessions = withBelow(
    rows,
    children.filter((_, at) => isSession(commands[at]!)),
  )
  await endFollowed(sessions, () => Date.now(), listing)
  // The service by its pid and start, now with no session left under it to end with it.
  const again = await listing()
  if (
    again?.some((row) => sameProcess(row, { pid: lock.pid, start: lock.start! }, process.platform))
  )
    process.kill(service.pid, "SIGKILL")
  return [service, ...sessions].map((row) => named(rows.find((one) => one.pid === row.pid)!))
}
