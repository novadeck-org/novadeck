import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

import { keep } from "./call-memory.js"

/**
 * A Stop says only that something runs on, and the status line lists a new subagent late:
 * the idle snapshots drawn first after that Stop may name no subagent that runs (seen on
 * 1.5.1 and 1.5.2), the first to name it coming about 0.5 s after the Stop on Linux and
 * macOS and 0.7 to 0.85 s on Windows, behind two bare ones (probed 2026-11-06, 1.5.2).
 * Once listed it stays listed, on the snapshots after later turns too. A bare one would
 * read as nothing running, and settle the terminal, so what such a Stop left is held: idle
 * snapshots count nothing until one names a subagent running. It draws a snapshot only
 * when something changed, so the hold ends by itself after `listingMs`, with the count of
 * the latest idle snapshot, and only starts where something will hear of that
 * (`followHolds`). A model call ends it too, as the agent's working again.
 * Only a subagent is late, so there's nothing to hold where PreToolUse told of no subagent
 * yet to be listed, as after a turn that left only a command. Windows may run no such hook
 * (`Machine.cmdPrints`), so where none has reported every such Stop holds. All of this is
 * each process's, as two may run one conversation; where a report can't name its process
 * (`instance` null) it matches no other's, and so reads as it would without any of this.
 */
export const listingMs = 5000

type Process = Pick<EventBase<"agy">, "sessionId" | "instance">

type Hold = {
  readonly timer: NodeJS.Timeout
  /** When the Stop's hook started: a snapshot drawn before it accounts for nothing. */
  readonly stop: number
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
  if (!runsOn || calls.get(key) === false || !followers.has(key)) return
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
  holds.set(key, { timer, stop: base.startedAt })
}

/**
 * Whether an idle snapshot counting `agents` running may be taken at its word: always but
 * during a hold, which only a snapshot newer than its Stop naming one running ends.
 */
export const accounted = (base: EventBase<"agy">, agents: number): boolean => {
  const key = keyOf(base)
  keep(counts, key, agents)
  const hold = holds.get(key)
  if (hold && base.startedAt <= hold.stop) return false
  if (agents > 0) listed(key)
  if (!hold) return true
  if (agents === 0) return false
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
