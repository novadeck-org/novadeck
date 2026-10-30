import { darwin } from "./reap/darwin.js"
import { linux } from "./reap/linux.js"
import { waitWhile, type Process, type Scope, type Table } from "./reap/process.js"
import { windows, type Trees } from "./reap/windows.js"

export type { Trees } from "./reap/windows.js"

export type ReapOptions = {
  /**
   * On Windows, the tree reader a forcible end goes through: it ends the process and what it
   * started, each only as the one it read, and taskkill ends the tree by recorded parent pids
   * only where it can't read it. Without one, a forcible end takes the process alone, and the
   * next round finds what it started.
   */
  readonly trees?: Trees
}

const tableFor = (options: ReapOptions = {}): Table =>
  process.platform === "win32"
    ? windows(options.trees)
    : process.platform === "darwin"
      ? darwin
      : linux

// How a leftover is reported: `bash (123)`, or `bash (123, stopped)` for one that could
// never have exited by itself; on Windows too its recorded parent, `cmd#12 gone`, which
// tells a program its shell's tree could not reach from one it should have.
const named = (one: Process): string =>
  `${one.comm} (${one.pid}${one.stopped ? ", stopped" : ""}${one.parent ? `, parent ${one.parent}` : ""})`

/**
 * The sandbox's processes now, each named as a leftover is, with its recorded parent on
 * Windows; none elsewhere. Taken while its programs still run, it names the parent a
 * leftover later records as gone, which tells a program started apart from its shell from
 * one the shell's tree should have held.
 */
export const census = async (sandbox: Scope): Promise<string[]> =>
  process.platform === "win32" ? (await tableFor().list(sandbox)).map(named) : []

/**
 * One round of `reap` over the processes it found: each gets three seconds to end by
 * itself; one still running then is asked to end, then ended forcibly if it outlives two
 * seconds more, each only should it still be the process found. Returns those that had to
 * be ended, as they were when asked, so one stopped while it was waited for is named so.
 */
const endFound = async (
  table: Table,
  sandbox: Scope,
  found: readonly Process[],
): Promise<readonly Process[]> => {
  await waitWhile(() => found.some((one) => table.alive(sandbox, one)), 3000)
  const leftover = await table.current(sandbox, found)
  await Promise.all(leftover.map((one) => table.end(one, false)))
  await waitWhile(() => leftover.some((one) => table.alive(sandbox, one)), 2000)
  const holding = await table.current(sandbox, leftover)
  await Promise.all(holding.map((one) => table.end(one, true)))
  return leftover
}

/**
 * Ends the processes still running in the sandbox once what used it has closed: those that
 * started after it was made and whose working folder is inside it, or whose HOME is its
 * home. A program the closing reached may take a moment to exit, so each gets
 * three seconds to end by itself; one still running then is asked to end (SIGTERM; on
 * Windows, which can't ask, ended), then ended forcibly (SIGKILL; on Windows with what it
 * started) if it outlives two seconds more, each only should it still be the process
 * found. As ending one may leave a child behind, it looks again, up to five times, until
 * it finds none it hasn't seen. Returns those that had to be ended, by their commands'
 * names and pids, each marked `stopped` should it have been, as a leak the caller reports.
 * On Linux it reads /proc; on Windows it asks the system through a lister of its own;
 * on macOS it asks `ps` and `lsof`.
 */
export const reap = async (sandbox: Scope, options: ReapOptions = {}): Promise<string[]> => {
  const table = tableFor(options)
  const seen = new Set<string>()
  const leftovers: string[] = []
  for (let round = 0; round < 5; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each round looks again after the last.
    const found = (await table.list(sandbox)).filter((one) => !seen.has(`${one.pid}:${one.start}`))
    if (found.length === 0) break
    for (const one of found) seen.add(`${one.pid}:${one.start}`)
    // eslint-disable-next-line no-await-in-loop -- As above.
    leftovers.push(...(await endFound(table, sandbox, found)).map(named))
  }
  return leftovers
}
