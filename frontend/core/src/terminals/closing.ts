import type { TerminalMetadata } from "../types"

// Why closing a terminal asks first, each a thing the person would lose. Where the backend
// keeps closed terminals (History), closing can be undone, so it asks only for what
// restoring can't give back; elsewhere it is final, and asks while a program runs.
export type CloseReason =
  // A program runs in its shell besides the prompt; closing ends it.
  | "program"
  // Its agent is mid-turn; closing stops the turn.
  | "working"
  // Its agent runs, and closing it can't be undone: it has no session to resume, or its
  // harness isn't connected.
  | "unrestorable"

export const closeReasons = (
  terminal: TerminalMetadata,
  keepsHistory: boolean,
): readonly CloseReason[] => {
  if (!keepsHistory) return terminal.state === "running" ? ["program"] : []
  const agent = terminal.state === "running" ? terminal.agent : undefined
  return [
    // The runner counts an agent as a running program too, so only a plain one is asked about.
    ...(!agent && terminal.busy ? (["program"] as const) : []),
    ...(agent?.working ? (["working"] as const) : []),
    // `restorable` is the backend's word; an agent is never assumed to restore.
    ...(agent && !terminal.restorable ? (["unrestorable"] as const) : []),
  ]
}
