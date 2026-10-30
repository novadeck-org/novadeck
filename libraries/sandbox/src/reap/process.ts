import type { Sandbox } from "../sandbox.js"

/** What reaping needs of a sandbox. */
export type Scope = Pick<Sandbox, "root" | "home" | "started">

/**
 * A process of the sandbox: its command's name, its start, which with its pid tells it
 * apart from a later process given the same pid, and whether it was stopped, as by job
 * control, when last read (never on Windows, which has no such state).
 */
export type Process = {
  readonly pid: number
  readonly comm: string
  readonly start: number
  readonly stopped: boolean
  /** On Windows, how its recorded parent stands, for a leftover's report. */
  readonly parent?: string
}

/** How a platform finds the sandbox's processes, tells whether one still runs, and ends it. */
export type Table = {
  /** The processes of the sandbox now. */
  readonly list: (sandbox: Scope) => Promise<readonly Process[]>
  /** Whether the process may still run, cheaply enough to ask again and again. */
  readonly alive: (sandbox: Scope, one: Process) => boolean
  /** Those of them still the same processes of the sandbox, as they are now. */
  readonly current: (sandbox: Scope, found: readonly Process[]) => Promise<readonly Process[]>
  /** Asks the process to end, or with `forcibly` ends it and, where it can, what it started. */
  readonly end: (one: Process, forcibly: boolean) => Promise<void>
}

/**
 * Whether the pid names a process of the caller's now, by signal 0. One it may not signal
 * (EPERM) is another user's or the system's, which no sandbox's process is: the pid has
 * been given to another process, so the one found has gone.
 */
export const pidRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Asks the process to end with SIGTERM, or with `forcibly` ends it with SIGKILL. */
export const signal = async (one: Process, forcibly: boolean): Promise<void> => {
  try {
    process.kill(one.pid, forcibly ? "SIGKILL" : "SIGTERM")
  } catch {
    // Gone meanwhile.
  }
}

/** Waits while `busy` holds, looking again every 50 ms, for `ms` at most. */
export const waitWhile = async (busy: () => boolean, ms: number): Promise<void> => {
  const deadline = Date.now() + ms
  while (busy() && Date.now() < deadline)
    // eslint-disable-next-line no-await-in-loop -- Looks again until `busy` stops holding.
    await new Promise((resolve) => setTimeout(resolve, 50))
}
