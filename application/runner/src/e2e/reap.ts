import { readdirSync, readFileSync, readlinkSync } from "node:fs"

import type { Sandbox } from "./sandbox.js"

/**
 * A process as /proc shows it: its command's name, its start in clock ticks since boot,
 * which with its pid tells it apart from a later process given the same pid, and whether
 * it was stopped, as by job control, when last read.
 */
type Process = {
  readonly pid: number
  readonly comm: string
  readonly start: number
  readonly stopped: boolean
}

/**
 * The process with the pid, should it belong to the sandbox. It reads the process's
 * `stat` for its state and start, and passes over a zombie and any process that started
 * before the sandbox. Only for the rest does it read the target of `cwd`, then, should
 * that not be inside the sandbox, `environ`, searched only for `HOME=<sandbox home>`
 * and neither kept nor printed, and last its `comm`.
 */
const member = (
  sandbox: Pick<Sandbox, "root" | "home" | "started">,
  pid: number,
): Process | undefined => {
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

const processes = (sandbox: Pick<Sandbox, "root" | "home" | "started">): Process[] =>
  readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name) && Number(name) !== process.pid)
    .flatMap((name) => member(sandbox, Number(name)) ?? [])

// Whether the process is still the same one, still the sandbox's, and not a zombie.
const still = (sandbox: Pick<Sandbox, "root" | "home" | "started">, one: Process): boolean =>
  member(sandbox, one.pid)?.start === one.start

// Signals the process, should it still be the one found.
const signal = (
  sandbox: Pick<Sandbox, "root" | "home" | "started">,
  one: Process,
  name: NodeJS.Signals,
) => {
  if (!still(sandbox, one)) return
  try {
    process.kill(one.pid, name)
  } catch {
    // Gone meanwhile.
  }
}

// Waits until none of them is still running or the time is up.
const ended = async (
  sandbox: Pick<Sandbox, "root" | "home" | "started">,
  found: readonly Process[],
  ms: number,
): Promise<void> => {
  const deadline = Date.now() + ms
  while (found.some((one) => still(sandbox, one)) && Date.now() < deadline)
    // eslint-disable-next-line no-await-in-loop -- Waits for them to end.
    await new Promise((resolve) => setTimeout(resolve, 50))
}

// How a leftover is reported: `claude (123)`, or `claude (123, stopped)` for one that
// could never have exited by itself.
const named = (one: Process): string => `${one.comm} (${one.pid}${one.stopped ? ", stopped" : ""})`

/**
 * Ends the processes still running in the sandbox once its deck has closed: those that
 * started after it was made and whose working folder is inside it, or whose HOME is its
 * home. A harness the deck's hangup reached may take a moment to exit, so each gets
 * three seconds to end by itself; one still running then gets SIGTERM, then SIGKILL if it
 * outlives two seconds more. As ending one may leave a child behind, it looks again,
 * up to five times, until it finds none it hasn't seen. Returns those that had to be
 * ended, by their commands' names and pids, each marked `stopped` should it have been, as
 * a leak the test reports. Linux only, as it reads
 * /proc.
 */
export const reap = async (
  sandbox: Pick<Sandbox, "root" | "home" | "started">,
): Promise<string[]> => {
  const seen = new Set<string>()
  const leftovers: string[] = []
  for (let round = 0; round < 5; round += 1) {
    const found = processes(sandbox).filter((one) => !seen.has(`${one.pid}:${one.start}`))
    if (found.length === 0) break
    for (const one of found) seen.add(`${one.pid}:${one.start}`)
    // eslint-disable-next-line no-await-in-loop -- Each round waits on the one found.
    await ended(sandbox, found, 3000)
    // Each as it is now, so one stopped while it was waited for is named stopped.
    const leftover = found.flatMap((one) => {
      const now = member(sandbox, one.pid)
      return now?.start === one.start ? [now] : []
    })
    for (const one of leftover) signal(sandbox, one, "SIGTERM")
    // eslint-disable-next-line no-await-in-loop -- As above.
    await ended(sandbox, leftover, 2000)
    for (const one of leftover) signal(sandbox, one, "SIGKILL")
    leftovers.push(...leftover.map(named))
  }
  return leftovers
}
