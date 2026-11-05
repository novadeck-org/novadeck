import { waitWhile, type Process, type Scope, type Table } from "./process.js"

// How a leftover is reported: `bash (123)`, or `bash (123, stopped)` for one that could
// never have exited by itself; on Windows too its recorded parent, `cmd#12 gone`, which
// tells a program its shell's tree could not reach from one it should have.
export const named = (one: Process): string =>
  `${one.comm} (${one.pid}${one.stopped ? ", stopped" : ""}${one.parent ? `, parent ${one.parent}` : ""})`

/**
 * One round of `reap` over the processes it found: each gets three seconds to end by
 * itself; one still running then is asked to end, then ended forcibly if it outlives two
 * seconds more, each only should it still be the process found, and every wait cut short
 * at `until`. Returns those that had to be ended, as they were when asked, so one stopped
 * while it was waited for is named so.
 */
const endFound = async (
  table: Table,
  sandbox: Scope,
  found: readonly Process[],
  until: number,
): Promise<readonly Process[]> => {
  const left = (ms: number) => Math.min(ms, until - Date.now())
  await waitWhile(() => found.some((one) => table.alive(sandbox, one)), left(3000))
  const leftover = await table.current(sandbox, found)
  await Promise.all(leftover.map((one) => table.end(one, false, until)))
  await waitWhile(() => leftover.some((one) => table.alive(sandbox, one)), left(2000))
  const holding = await table.current(sandbox, leftover)
  await Promise.all(holding.map((one) => table.end(one, true, until)))
  return leftover
}

// A process by its pid and start, which no later process given the same pid shares.
const key = (one: Process): string => `${one.pid}:${one.start}`

/** How many rounds `reap` takes, each over what the last left. */
const rounds = 5

/**
 * `reap` over the table, within `within` ms: rounds of `endFound`, each over the processes
 * the last didn't see, until one finds none, five have run, or the time is up. Should
 * processes it hasn't seen still run then, as a supervisor that restarts its worker each
 * time it is ended leaves one, each is ended forcibly, unwaited, and named so: a list that
 * looks complete never hides one.
 */
export const reapTable = async (
  table: Table,
  sandbox: Scope,
  within: number,
): Promise<string[]> => {
  const until = Date.now() + within
  const seen = new Set<string>()
  const unseen = async () => (await table.list(sandbox)).filter((one) => !seen.has(key(one)))
  const leftovers: string[] = []
  for (let round = 0; round < rounds && Date.now() < until; round += 1) {
    // eslint-disable-next-line no-await-in-loop -- Each round looks again after the last.
    const found = await unseen()
    if (found.length === 0) return leftovers
    for (const one of found) seen.add(key(one))
    // eslint-disable-next-line no-await-in-loop -- As above.
    leftovers.push(...(await endFound(table, sandbox, found, until)).map(named))
  }
  const remaining = await unseen()
  await Promise.all(remaining.map((one) => table.end(one, true, Date.now())))
  return [
    ...leftovers,
    ...remaining.map((one) => `${named(one)} ended unwaited as reaping ran out`),
  ]
}
