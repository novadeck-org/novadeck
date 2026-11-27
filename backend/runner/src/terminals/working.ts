import type { TerminalChange, TerminalSummary } from "@novadeck/protocol"

import { wakeGraceMs } from "../harnesses/waits.js"

/** What `watchWorking` reads of a terminal change: `terminals.watch`'s, or as little as that. */
export type WorkingChange =
  | { readonly type: "changed"; readonly terminal: Pick<TerminalSummary, "id" | "activity"> }
  | Exclude<TerminalChange, { readonly type: "changed" }>

/**
 * How long an agent is at work, or null if it has no known end: on a
 * turn, with subagents it started running (during its turn or after it, as Codex's outlive
 * one), or waiting on jobs or a wake-up of its own that bring it back with no word from
 * anyone. A turn held on the person's answer with no subagent running doesn't count, as
 * nothing goes on until they're back, nor do commands it left running that may run for ever,
 * as a dev server. Its crons are told apart (`watchWorking`'s `scheduledUntil`): no summary has them.
 */
export const activityUntil = (
  { activity }: Pick<TerminalSummary, "activity">,
  now: number,
): number | null | undefined => {
  if (activity === null) return undefined
  const { state, background, waiting, attention, subagents } = activity
  const held = attention.pending > (attention.detached ?? 0)
  if ((state === "working" && !held) || subagents.length > 0 || (background?.agents ?? 0) > 0)
    return null
  let latest = waiting?.wake?.at ?? -Infinity
  for (const { until } of waiting?.jobs ?? []) {
    if (until === null) return null
    latest = Math.max(latest, until)
  }
  const expiry = latest + wakeGraceMs
  return expiry > now ? expiry : undefined
}

/**
 * Follows every terminal's changes and tells whether any agent is at work, each time that
 * changes once the listing has synced; nothing until one is. An agent with a cron of its own
 * (`scheduledUntil`, see schedules.ts), as `/loop` sets, counts too. Check again at the last
 * timed wait's expiry even when the terminal reports no change.
 */
export const watchWorking = async (
  changes: AsyncIterable<WorkingChange>,
  tell: (working: boolean) => void,
  scheduledUntil: (terminalId: string) => number | null | undefined = () => undefined,
): Promise<void> => {
  const atWork = new Set<string>()
  const expiries = new Map<string, NodeJS.Timeout>()
  let synced = false
  let told = false
  const publish = () => {
    const working = atWork.size > 0
    if (synced && working !== told) {
      told = working
      tell(working)
    }
  }
  const clearExpiry = (id: string) => {
    clearTimeout(expiries.get(id))
    expiries.delete(id)
  }
  const update = (terminal: Pick<TerminalSummary, "id" | "activity">) => {
    const { id } = terminal
    clearExpiry(id)
    const now = Date.now()
    const activity = activityUntil(terminal, now)
    const schedule = activity === null ? null : scheduledUntil(id)
    const until = schedule === null ? null : Math.max(activity ?? -Infinity, schedule ?? -Infinity)
    if (until === null || until > now) atWork.add(id)
    else atWork.delete(id)
    if (until !== null && until > now) {
      const delay = Math.min(until - now, 2 ** 31 - 1)
      expiries.set(
        id,
        setTimeout(() => {
          update(terminal)
          publish()
        }, delay).unref(),
      )
    }
  }
  try {
    for await (const change of changes) {
      if (change.type === "synced") synced = true
      else if (change.type === "removed") {
        clearExpiry(change.terminalId)
        atWork.delete(change.terminalId)
      } else update(change.terminal)
      publish()
    }
  } finally {
    for (const timer of expiries.values()) clearTimeout(timer)
    if (told) tell(false)
  }
}
