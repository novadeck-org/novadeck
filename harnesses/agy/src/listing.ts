import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

import { keep, tasksCounted } from "./call-memory.js"

/**
 * A Stop says only that something runs on, and the status line lists it late: the idle
 * snapshots drawn first after that Stop may name no subagent that runs (seen on 1.5.1 and
 * 1.5.2), the first to name it coming 0.5 s after the Stop on Linux and macOS and 0.7 s on
 * Windows, behind two bare ones (probed 2026-11-06, 1.5.2). A bare one would read as
 * nothing running, and settle the terminal, so what such a Stop left is held: idle
 * snapshots count nothing until one accounts for it, as a subagent running or, in a turn
 * that called none, a task. Its first idle snapshot counts a command's task, and lists any
 * subagent that had a moment to start. It draws a snapshot only when something changed, so
 * the hold ends by itself after `listingMs`, reading as a bare snapshot would have, and
 * only starts where something will hear of that (`followHolds`). A model call ends it too,
 * as the agent's working again.
 * A Stop starts it, not a call, as Windows may run no PreToolUse hook (`Machine.cmdPrints`).
 * That hook only tells a task from a subagent called beside it: where none has reported,
 * only a task newer than the last idle snapshot's accounts for anything, as one a dev
 * server has held all along says nothing of this turn.
 */
export const listingMs = 5000

type Hold = {
  readonly timer: NodeJS.Timeout
  /** Whether a subagent it called is yet to be listed; undefined where no hook tells. */
  readonly subagent: boolean | undefined
}

// What each conversation's latest Stop left unaccounted for.
const holds = new Map<string, Hold>()

// The conversations a PreToolUse reported, each with whether a subagent it called is yet to
// be listed. A hold running out, or a Stop saying nothing runs on, gives up on one.
const calls = new Map<string, boolean>()

// Who hears of a hold that ran out, for each conversation Novadeck follows: a conversation
// may run in two terminals.
const followers = new Map<string, Set<(event: HarnessEvent) => void>>()

const release = (conversation: string): void => {
  clearTimeout(holds.get(conversation)?.timer)
  holds.delete(conversation)
}

const listed = (conversation: string): void => {
  if (calls.has(conversation)) calls.set(conversation, false)
}

/** The conversation called the tool `name`. */
export const toolCalled = (conversation: string, name: string): void => {
  keep(calls, conversation, name === "invoke_subagent" || calls.get(conversation) === true)
}

/** A model call of the conversation. */
export const invoked = release

/** The conversation's Stop, which says whether anything `runsOn`. */
export const stopped = (base: EventBase<"agy">, runsOn: boolean): void => {
  const { sessionId: conversation, startedAt } = base
  release(conversation)
  if (!runsOn) listed(conversation)
  if (!runsOn || !followers.has(conversation)) return
  const timer = setTimeout(() => {
    holds.delete(conversation)
    listed(conversation)
    for (const follower of followers.get(conversation) ?? [])
      follower({
        type: "turn-idle",
        ...base,
        startedAt: startedAt + listingMs,
        background: { agents: 0, tasks: 0 },
      })
  }, listingMs)
  timer.unref()
  holds.set(conversation, { timer, subagent: calls.get(conversation) })
}

/**
 * Whether an idle snapshot counting `agents` running and `tasks` may be taken at its word:
 * always but during a hold, which one that accounts for what its Stop left ends.
 */
export const accounted = (conversation: string, agents: number, tasks: number): boolean => {
  if (agents > 0) listed(conversation)
  const hold = holds.get(conversation)
  if (!hold) return true
  const tasksTell =
    hold.subagent === undefined ? tasks > tasksCounted(conversation) : !hold.subagent && tasks > 0
  if (agents === 0 && !tasksTell) return false
  release(conversation)
  return true
}

/** Follows a bound conversation until `signal` aborts, for the holds that run out. */
export const followHolds: NonNullable<Harness["watch"]> = ({ sessionId }, signal, emit) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const hearing = followers.get(sessionId) ?? new Set()
    followers.set(sessionId, hearing.add(emit))
    signal.addEventListener(
      "abort",
      () => {
        hearing.delete(emit)
        if (hearing.size === 0 && followers.get(sessionId) === hearing) followers.delete(sessionId)
        resolve()
      },
      { once: true },
    )
  })
