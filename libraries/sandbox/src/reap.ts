import { darwin } from "./reap/darwin.js"
import { linux } from "./reap/linux.js"
import type { Scope, Table } from "./reap/process.js"
import { named, reapTable } from "./reap/rounds.js"
import { windows, type ProcessTrees } from "./reap/windows.js"

export type { ProcessTrees } from "./reap/windows.js"

export type ReapOptions = {
  /**
   * On Windows, the tree reader a forcible end goes through: it ends the process and what it
   * started, each only as the one it read, and taskkill ends the tree by recorded parent pids
   * only where it can't read it. Without one, a forcible end takes the process alone, and the
   * next round finds what it started.
   */
  readonly trees?: ProcessTrees
}

const tableFor = (options: ReapOptions = {}): Table =>
  process.platform === "win32"
    ? windows(options.trees)
    : process.platform === "darwin"
      ? darwin
      : linux

/**
 * The sandbox's processes now, each named as a leftover is, with its recorded parent on
 * Windows; none elsewhere. Taken while its programs still run, it names the parent a
 * leftover later records as gone, which tells a program started apart from its shell from
 * one the shell's tree should have held.
 */
export const census = async (sandbox: Scope): Promise<string[]> =>
  process.platform === "win32" ? (await tableFor().list(sandbox)).map(named) : []

/**
 * Ends the processes still running in the sandbox once what used it has closed: those that
 * started after it was made and whose working folder is inside it, or whose HOME is its
 * home, and on Linux and macOS those that one of them started, or that are in a process
 * group of one, never through the caller's own group. A program the closing reached may
 * take a moment to exit, so each gets three seconds to end by itself; one still running
 * then is asked to end (SIGTERM; on Windows, which can't ask, ended), then ended forcibly
 * (SIGKILL; on Windows with what it started) if it outlives two seconds more, each only
 * should it still be the process found. As ending one may leave a child behind, it looks
 * again, up to five times, until it finds none it hasn't seen, starting no round and
 * waiting no longer past 15 seconds, so it ends inside a caller's own bound on its
 * cleanup (the e2e fixture's is 20) unless listing or ending is itself slow; should one it
 * hasn't seen still run then, it is ended forcibly, unwaited, and named so. Returns those
 * that had to be ended, by their commands' names and pids, each marked `stopped` should it
 * have been, as a leak the caller reports. On Linux it reads /proc; on Windows it asks the
 * system through a lister of its own; on macOS it asks `ps` and `lsof`.
 */
export const reap = async (sandbox: Scope, options: ReapOptions = {}): Promise<string[]> =>
  reapTable(tableFor(options), sandbox, 15_000)
