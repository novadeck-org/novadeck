import type { TerminalChange, TerminalSummary } from "@novadeck/protocol"

/** What `watchWorking` reads of a terminal change: `terminals.watch`'s, or as little as that. */
export type WorkingChange =
  | { readonly type: "changed"; readonly terminal: Pick<TerminalSummary, "id" | "activity"> }
  | Exclude<TerminalChange, { readonly type: "changed" }>

/**
 * Whether the agent in a terminal is at work, which a sleeping computer would stall: on a
 * turn, with subagents it started running (during its turn or after it, as Codex's outlive
 * one), or waiting on jobs or a wake-up of its own that bring it back with no word from
 * anyone. A turn held on the person's answer with no subagent running doesn't count, as
 * nothing goes on until they're back, nor do commands it left running that may run for ever,
 * as a dev server. Its crons are told apart (`watchWorking`'s `scheduledUntil`): no summary has them.
 */
export const agentAtWork = ({ activity }: Pick<TerminalSummary, "activity">): boolean => {
  if (activity === null) return false
  const { state, background, waiting, attention, subagents } = activity
  const held = attention.pending > (attention.detached ?? 0)
  return (
    (state === "working" && !held) ||
    subagents.length > 0 ||
    (background?.agents ?? 0) > 0 ||
    (waiting?.jobs.length ?? 0) > 0 ||
    (waiting?.wake ?? null) !== null
  )
}

/**
 * Follows every terminal's changes and tells whether any agent is at work, each time that
 * changes once the listing has synced; nothing until one is. An agent with a cron of its own
 * (`scheduledUntil`, see schedules.ts), as `/loop` sets, counts too. Check again at the last
 * one-shot schedule's expiry even when the terminal reports no change.
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
    const busy = agentAtWork(terminal)
    const until = busy ? undefined : scheduledUntil(id)
    if (busy || until !== undefined) atWork.add(id)
    else atWork.delete(id)
    if (typeof until === "number") {
      const delay = Math.max(1, Math.min(until - Date.now(), 2 ** 31 - 1))
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
