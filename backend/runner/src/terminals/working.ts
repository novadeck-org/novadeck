import type { TerminalChange, TerminalSummary } from "@novadeck/protocol"

/** What `watchWorking` reads of a terminal change: `terminals.watch`'s, or as little as that. */
export type WorkingChange =
  | { readonly type: "changed"; readonly terminal: Pick<TerminalSummary, "id" | "activity"> }
  | Exclude<TerminalChange, { readonly type: "changed" }>

/**
 * Whether the agent in a terminal is at work, which a sleeping computer would stall: on a
 * turn, with subagents it started running on, or waiting on jobs or a wake-up of its own
 * that bring it back with no word from anyone. A turn held on the person's answer doesn't
 * count, as nothing goes on until they're back, nor do commands it left running that may run
 * for ever, as a dev server.
 */
export const agentAtWork = ({ activity }: Pick<TerminalSummary, "activity">): boolean => {
  if (activity === null) return false
  const { state, background, waiting, attention } = activity
  const held = attention.pending > (attention.detached ?? 0)
  return (
    (state === "working" && !held) ||
    (background?.agents ?? 0) > 0 ||
    (waiting?.jobs.length ?? 0) > 0 ||
    (waiting?.wake ?? null) !== null
  )
}

/**
 * Follows every terminal's changes and tells whether any agent is at work, each time that
 * changes once the listing has synced; nothing until one is. When the changes end, as when
 * the runner closes, it tells false if it last told true.
 */
export const watchWorking = async (
  changes: AsyncIterable<WorkingChange>,
  tell: (working: boolean) => void,
): Promise<void> => {
  const atWork = new Set<string>()
  let synced = false
  let told = false
  for await (const change of changes) {
    if (change.type === "synced") synced = true
    else if (change.type === "removed") atWork.delete(change.terminalId)
    else if (agentAtWork(change.terminal)) atWork.add(change.terminal.id)
    else atWork.delete(change.terminal.id)
    const working = atWork.size > 0
    if (synced && working !== told) {
      told = working
      tell(working)
    }
  }
  if (told) tell(false)
}
