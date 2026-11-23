import { spawn, type ChildProcessByStdio } from "node:child_process"
import { createInterface } from "node:readline"
import type { Readable, Writable } from "node:stream"

import type { Followed, Listed } from "./descendants.js"
import type { Scope, Scopes } from "./scopes.js"
import { relayMs } from "./trees.js"

/**
 * One of the relay's answers (`novadeck-relay jobs`, backend/relay/src/jobs.rs): to the ask
 * numbered `n`.
 */
type Answer = {
  readonly n?: number
  readonly held?: boolean
  readonly processes?: unknown
  readonly error?: string
}

/** The relay's `jobs` mode, started: what asks go to, and what answers come from. */
export type Keeper = ChildProcessByStdio<Writable, Readable, null>

/** Starts `relay jobs`, the keeper of the terminals' jobs. */
export type StartKeeper = (relay: string) => Keeper

const startKeeper: StartKeeper = (relay) =>
  spawn(relay, ["jobs"], {
    stdio: ["pipe", "pipe", "ignore"],
    windowsHide: true,
  })

/** A process the relay lists, as a listing row: a job's member has no group or terminal. */
export const listedOf = (processes: unknown): readonly Listed[] | undefined => {
  if (!Array.isArray(processes)) return undefined
  return processes.flatMap((each: unknown) => {
    const { pid, startedAt, parent, name } = (each ?? {}) as Record<string, unknown>
    if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(startedAt)) return []
    return [
      {
        pid: pid as number,
        parent: Number.isSafeInteger(parent) ? (parent as number) : 0,
        group: 0,
        foreground: 0,
        started: String(startedAt),
        zombie: false,
        ...(typeof name === "string" && name !== "" && { command: name }),
      },
    ]
  })
}

/**
 * Windows' scopes: each terminal's shell goes into a job object of its own as soon as its pid
 * is known, kept by one relay that runs as long as the runner (`novadeck-relay jobs`), as the
 * user's systemd keeps a Linux terminal's scope. From then on all the shell starts is in the
 * job, however it starts it and whatever parent it then records, so what an agent left
 * detached there is found as the terminal closes, and ended by its pid and start. What the
 * shell started before it got there stays out, so its startup command waits for it (`held`).
 * A job only holds: the relay's exit, or a terminal's job let go, ends nothing. It allows no
 * breakaway, as Git Bash breaks away from any job that does (backend/relay/src/jobs.rs).
 *
 * Where the first hold fails for want of a relay that keeps jobs, as an older one, the rest
 * get none either, as before; one that fails for its program alone, as one that exited at
 * once, changes nothing. Where the relay exits, the jobs it held are lost, and terminals
 * started after it get a new one.
 */
export class WindowsJobs implements Scopes {
  private state: "unknown" | "works" | "off" = "unknown"
  private keeper: Keeper | undefined
  private readonly waiting = new Map<number, (answer: Answer | undefined) => void>()
  private asked = 0
  private terminals = 0

  constructor(
    private readonly relay: () => Promise<string | undefined>,
    private readonly start: StartKeeper = startKeeper,
  ) {}

  active(): boolean {
    return this.state !== "off"
  }

  contain(pid: number): Scope {
    if (this.state === "off") return { ...unheld, held: Promise.resolve(false) }
    const terminal = `term${pid}-${++this.terminals}`
    const held = this.ask(`hold ${terminal} ${pid}`).then((answer) => {
      if (answer?.held === true) {
        this.state = "works"
        return true
      }
      // Its own failure, as a shell that ended at once, says nothing of the relay's.
      if (this.state === "unknown" && answer?.held !== false) {
        this.state = "off"
        console.error("Novadeck's terminals get no job objects on Windows:", answer?.error ?? "")
      }
      return false
    })
    const listed = async (): Promise<readonly Listed[] | undefined> =>
      (await held) ? listedOf((await this.ask(`members ${terminal}`))?.processes) : undefined
    let released = false
    const release = () => {
      if (released) return
      released = true
      void held.then(async (was) => {
        if (was) await this.ask(`release ${terminal}`)
      })
    }
    return {
      cause: () => undefined,
      weigh: () => Promise.resolve(),
      held,
      listed,
      members: async () => (await listed())?.map((row) => row.pid),
      end: async (ones) => {
        if (ones.length > 0) await this.ask(`end ${ones.map(named).join(" ")}`)
      },
      // What the shell left still runs in its job, which is kept until the terminal goes.
      exited: async () => {
        if ((await listed())?.length === 0) release()
      },
      done: release,
    }
  }

  /** `line`'s answer, or undefined where the relay can't answer it within `relayMs`. */
  private async ask(line: string): Promise<Answer | undefined> {
    const keeper = await this.started()
    if (!keeper) return undefined
    const n = ++this.asked
    return new Promise<Answer | undefined>((resolve) => {
      const timer = setTimeout(() => settle(undefined), relayMs)
      const settle = (answer: Answer | undefined) => {
        clearTimeout(timer)
        this.waiting.delete(n)
        resolve(answer)
      }
      this.waiting.set(n, settle)
      keeper.stdin.write(`${n} ${line}\n`, (error) => {
        if (error) settle(undefined)
      })
    })
  }

  private async started(): Promise<Keeper | undefined> {
    if (this.keeper) return this.keeper
    const relay = await this.relay()
    if (relay === undefined || this.keeper) return this.keeper
    let keeper: Keeper
    try {
      keeper = this.start(relay)
    } catch {
      return undefined
    }
    this.keeper = keeper
    const gone = () => {
      if (this.keeper !== keeper) return
      this.keeper = undefined
      for (const settle of this.waiting.values()) settle(undefined)
    }
    keeper.on("error", gone)
    keeper.on("exit", gone)
    keeper.stdin.on("error", gone)
    createInterface({ input: keeper.stdout }).on("line", (line) => {
      let answer: Answer
      try {
        answer = JSON.parse(line) as Answer
      } catch {
        return
      }
      if (typeof answer.n === "number") this.waiting.get(answer.n)?.(answer)
    })
    // It never holds the runner open: its exit ends the keeper's input, and the keeper with it.
    keeper.unref()
    for (const stream of [keeper.stdout, keeper.stdin] as {
      unref?: () => void
    }[])
      stream.unref?.()
    return keeper
  }
}

/** A process by its pid and start, as the relay names one. */
const named = ({ pid, started }: Followed): string => `${pid}:${started}`

/** A program left in no job, as where the relay keeps none. */
const unheld: Scope = {
  cause: () => undefined,
  weigh: () => Promise.resolve(),
  members: () => Promise.resolve(undefined),
  exited: () => Promise.resolve(),
}

/** The scopes on `platform`: Windows' jobs, kept by `relay`; none elsewhere. */
export const windowsJobs = (
  relay: () => Promise<string | undefined>,
  platform: NodeJS.Platform = process.platform,
): Scopes | undefined => (platform === "win32" ? new WindowsJobs(relay) : undefined)
