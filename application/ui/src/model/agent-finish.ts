import type { AgentTurnEnd, TerminalMetadata } from "./types"

// An agent that finished: its turn over on its own, completed or `failed` on an error,
// with nothing it started left that wakes it, as subagents do, and nothing waiting on the
// person. `reply` is the start of its last reply, where its harness tells it.
export type AgentFinish = { readonly failed: boolean; readonly reply?: string }

// The turn end of a terminal's agent Novadeck last took in, by its `at`: null when it
// showed none. Undefined before the terminal was first seen.
export type SeenEnd = number | null

const turnEnd = (terminal: TerminalMetadata): AgentTurnEnd | undefined =>
  terminal.state === "running" ? terminal.agent?.lastTurn : undefined

// Whether an agent is working: its turn, or subagents it left that will wake it.
export const agentWorking = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" && terminal.agent?.working === true

// What a terminal's status tells of its agent's turn ends, given the one last taken in:
// a finish when it shows an end not seen before, as its agent rests (see `AgentFinish`).
// An end is told apart by its `at`, not by watching the agent go from working to idle, so
// a status that skipped the working one, or several ends in one, still finishes once. The
// first sight of a terminal takes in what it shows, so an end from before a reload or a
// reconnect is never a finish. While the agent works on, an end waits to be taken in; one
// shown while it waits on the person, interrupted by them, or idle with no more said (as
// Antigravity's Escape or refusal) is taken in, and no finish: they were there.
export const sightTurnEnd = (
  seen: SeenEnd | undefined,
  terminal: TerminalMetadata,
): { readonly seen: SeenEnd; readonly finish?: AgentFinish } => {
  const end = turnEnd(terminal)
  if (seen === undefined) return { seen: end?.at ?? null }
  if (!end || end.at === seen || agentWorking(terminal)) return { seen }
  const waiting = terminal.state === "running" && terminal.agent?.attention !== undefined
  if (waiting || (end.outcome !== "completed" && end.outcome !== "failed")) return { seen: end.at }
  const failed = end.outcome === "failed"
  return {
    seen: end.at,
    finish: end.reply === undefined ? { failed } : { failed, reply: end.reply },
  }
}

// What a desktop notification says of a finish: who finished, by the terminal's handle
// where it has one, whether it failed, and the start of its reply.
export const finishNotice = (
  terminal: TerminalMetadata,
  { failed, reply }: AgentFinish,
): { readonly title: string; readonly body: string } => {
  const what = failed ? "stopped with an error" : "is done"
  return {
    title: terminal.handle
      ? `${terminal.handle} ${what}: ${terminal.name}`
      : `${terminal.name} ${what}`,
    body: reply ?? (failed ? "Its turn failed." : "Finished its turn."),
  }
}
