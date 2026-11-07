import type { TerminalMetadata } from "../types"
import { waitingOf } from "./waiting"

// Why closing a terminal asks first, each a thing the person would lose. Where the backend
// keeps closed terminals (History), closing can be undone, so it asks only for what
// restoring can't give back; elsewhere it is final, and asks while a program runs.
export type CloseReason =
  // A program runs in its shell besides the prompt; closing ends it.
  | "program"
  // Its agent is mid-turn; closing stops the turn.
  | "working"
  // Its agent is idle but not done: it waits on a job, a monitor or a wake-up it set, or
  // left tasks running in the background. Closing ends them, and a restore doesn't start
  // them again.
  | "background"
  // Its agent leads other running agents; closing it leaves them without a lead, and
  // History doesn't give the lead back.
  | "leads"
  // Its agent runs, and closing it can't be undone: it has no session to resume, or its
  // harness isn't connected.
  | "unrestorable"

export const closeReasons = (
  terminal: TerminalMetadata,
  keepsHistory: boolean,
  // Every terminal of its session, to see whom it leads.
  terminals: readonly TerminalMetadata[] = [],
  now = Date.now(),
): readonly CloseReason[] => {
  if (!keepsHistory) return terminal.state === "running" ? ["program"] : []
  const agent = terminal.state === "running" ? terminal.agent : undefined
  return [
    // The runner counts an agent as a running program too, so only a plain one is asked about.
    ...(!agent && terminal.busy ? (["program"] as const) : []),
    ...(agent?.working ? (["working"] as const) : []),
    // The waiting the tab shows: a wake-up or a monitor that has passed is over, though the
    // runner keeps it until the next turn.
    ...(agent && !agent.working && (waitingOf(terminal, now) || agent.background)
      ? (["background"] as const)
      : []),
    ...(terminal.handle &&
    terminals.some((each) => each.ledBy === terminal.handle && each.state === "running")
      ? (["leads"] as const)
      : []),
    // `restorable` is the backend's word; an agent is never assumed to restore.
    ...(agent && !terminal.restorable ? (["unrestorable"] as const) : []),
  ]
}
