import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

import { keep } from "./call-memory.js"

/**
 * A Stop says only that something runs on, and the status line lists it late: the idle
 * snapshots drawn first after that Stop may name no subagent that runs (seen on 1.5.1 and
 * 1.5.2), the first to name it coming 0.5 s after the Stop on Linux and macOS and 0.7 to
 * 0.8 s on Windows, behind two bare ones (probed 2026-11-06, 1.5.2). Once listed it stays
 * listed, on the snapshots after later turns too. A bare one would read as nothing running,
 * and settle the terminal, so what such a Stop left is held: idle snapshots count nothing
 * until one accounts for it, as a subagent running or, in a turn seen to call none, a task,
 * which its first idle snapshot counts. It draws a snapshot only when something changed,
 * so the hold ends by itself after `listingMs`, with the count of the latest idle snapshot,
 * and only starts where something will hear of that (`followHolds`). A model call ends it
 * too, as the agent's working again.
 * A Stop starts it, not a call, as Windows may run no PreToolUse hook (`Machine.cmdPrints`).
 * That hook only tells a task from a subagent called beside it: where none has reported a
 * task accounts for nothing, as it may be a dev server's, and only a listing or the time
 * ends the hold. All of this is each process's, as two may run one conversation.
 */
export const listingMs = 5000

type Process = Pick<EventBase<"agy">, "sessionId" | "instance">

type Hold = {
  readonly timer: NodeJS.Timeout
  /** Whether a subagent it called is yet to be listed; undefined where no hook tells. */
  readonly subagent: boolean | undefined
}

type Follower = {
  readonly emit: (event: HarnessEvent) => void
  readonly fail: (reason: unknown) => void
}

// What each process's latest Stop left unaccounted for.
const holds = new Map<string, Hold>()

// The processes a PreToolUse reported, each with whether a subagent it called is yet to be
// listed. A hold running out, or a Stop saying nothing runs on, gives up on one.
const calls = new Map<string, boolean>()

// How many subagents each process's latest idle snapshot counted running.
const counts = new Map<string, number>()

// Who hears of a hold that ran out, for each process Novadeck follows.
const followers = new Map<string, Follower>()

const keyOf = ({ sessionId, instance }: Process): string => `${sessionId}:${instance}`

const release = (key: string): void => {
  clearTimeout(holds.get(key)?.timer)
  holds.delete(key)
}

const listed = (key: string): void => {
  if (calls.has(key)) calls.set(key, false)
}

/** The process called the tool `name`. */
export const toolCalled = (process: Process, name: string): void => {
  const key = keyOf(process)
  keep(calls, key, name === "invoke_subagent" || calls.get(key) === true)
}

/** A model call of the process. */
export const invoked = (process: Process): void => {
  release(keyOf(process))
}

/** The process's Stop, which says whether anything `runsOn`. */
export const stopped = (base: EventBase<"agy">, runsOn: boolean): void => {
  const key = keyOf(base)
  release(key)
  if (!runsOn) listed(key)
  if (!runsOn || !followers.has(key)) return
  const timer = setTimeout(() => {
    holds.delete(key)
    listed(key)
    const follower = followers.get(key)
    try {
      follower?.emit({
        type: "turn-idle",
        ...base,
        startedAt: base.startedAt + listingMs,
        background: { agents: counts.get(key) ?? 0, tasks: 0 },
      })
    } catch (error) {
      follower?.fail(error)
    }
  }, listingMs)
  timer.unref()
  holds.set(key, { timer, subagent: calls.get(key) })
}

/**
 * Whether an idle snapshot counting `agents` running and `tasks` may be taken at its word:
 * always but during a hold, which one that accounts for what its Stop left ends.
 */
export const accounted = (process: Process, agents: number, tasks: number): boolean => {
  const key = keyOf(process)
  keep(counts, key, agents)
  if (agents > 0) listed(key)
  const hold = holds.get(key)
  if (!hold) return true
  if (agents === 0 && (hold.subagent !== false || tasks === 0)) return false
  release(key)
  return true
}

/** Follows a bound session's process until `signal` aborts, for the holds that run out. */
export const followHolds: NonNullable<Harness["watch"]> = (run, signal, emit) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) return resolve()
    const key = keyOf(run)
    const leave = () => {
      if (followers.get(key) === follower) followers.delete(key)
    }
    const follower: Follower = {
      emit,
      fail: (reason) => {
        leave()
        reject(reason)
      },
    }
    followers.set(key, follower)
    signal.addEventListener(
      "abort",
      () => {
        leave()
        resolve()
      },
      { once: true },
    )
  })
