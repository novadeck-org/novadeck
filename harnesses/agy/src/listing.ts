import type { EventBase, HarnessEvent } from "@novadeck/harness-core/events"
import type { Harness } from "@novadeck/harness-core/harness"

import { keep } from "./call-memory.js"

/**
 * A Stop says only that something runs on, and the status line lists it late: the idle
 * snapshots drawn first after that Stop may name no subagent that runs (from 1.5; 1.4 named
 * it in the first), the first to name it coming 0.5 s after the Stop on Linux and macOS and
 * 0.7 s on Windows, behind two bare ones (probed 2026-11-06, 1.5.2). A bare one would read
 * as nothing running, and settle the terminal, so what such a Stop left is held: idle
 * snapshots count nothing until one accounts for it, a subagent running or, in a turn that
 * started none, a task. Its first idle snapshot lists a command's task, and any subagent
 * that had a moment to start. A snapshot may be the last for a while, as it draws one only
 * when something changed, so the hold ends by itself after `listingMs`, reading as a
 * bare snapshot would have. A model call ends it too, as the agent's working again.
 * Started by a Stop, not its turn's PreToolUse, as Windows may run no PreToolUse hook
 * (`Machine.cmdPrints`); that hook only tells a task from a subagent starting beside it.
 */
export const listingMs = 5000

type Hold = { readonly timer: NodeJS.Timeout; readonly subagent: boolean }

// What each conversation's latest Stop left unaccounted for.
const holds = new Map<string, Hold>()

// The conversations whose running turn called a subagent.
const calling = new Map<string, true>()

// Who hears of a hold that ran out, for each conversation Novadeck follows.
const followers = new Map<string, (event: HarnessEvent) => void>()

const release = (conversation: string): void => {
  clearTimeout(holds.get(conversation)?.timer)
  holds.delete(conversation)
}

/** The conversation's running turn called a subagent. */
export const subagentCalled = (conversation: string): void => {
  keep(calling, conversation, true)
}

/** A model call of the conversation: a turn's first starts it afresh. */
export const invoked = (conversation: string, first: boolean): void => {
  release(conversation)
  if (first) calling.delete(conversation)
}

/** The conversation's Stop, which says whether anything `runsOn`. */
export const stopped = (base: EventBase<"agy">, runsOn: boolean): void => {
  const { sessionId: conversation, startedAt } = base
  release(conversation)
  if (!runsOn) return
  const timer = setTimeout(() => {
    holds.delete(conversation)
    followers.get(conversation)?.({
      type: "turn-idle",
      ...base,
      startedAt: startedAt + listingMs,
      background: { agents: 0, tasks: 0 },
    })
  }, listingMs)
  timer.unref()
  holds.set(conversation, { timer, subagent: calling.has(conversation) })
}

/**
 * Whether an idle snapshot counting `agents` running and `tasks` may be taken at its word:
 * always but during a hold, which one that accounts for what its Stop left ends.
 */
export const accounted = (conversation: string, agents: number, tasks: number): boolean => {
  const hold = holds.get(conversation)
  if (hold && agents === 0 && (hold.subagent || tasks === 0)) return false
  release(conversation)
  return true
}

/** Follows a bound conversation until `signal` aborts, for the holds that run out. */
export const followHolds: NonNullable<Harness["watch"]> = ({ sessionId }, signal, emit) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    followers.set(sessionId, emit)
    signal.addEventListener(
      "abort",
      () => {
        if (followers.get(sessionId) === emit) followers.delete(sessionId)
        resolve()
      },
      { once: true },
    )
  })
