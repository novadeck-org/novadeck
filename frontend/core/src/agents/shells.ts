import type { AgentShell } from "../types"

// What a background shell is, by how it stands: running, or ended by exiting 0 (`ended`), by
// a code that isn't 0 (`failed`), or by something that left no code (`stopped`: the agent or
// the person ended it, or its harness lost it).
export type ShellState = "running" | "failed" | "ended" | "stopped"

export const shellStateOf = ({ exit }: Pick<AgentShell, "exit">): ShellState =>
  exit === null ? "running" : exit.code === null ? "stopped" : exit.code === 0 ? "ended" : "failed"

// How many of the shells run and how many failed, as a terminal's bar and the shells' own
// header count them.
export const shellCounts = (
  shells: readonly Pick<AgentShell, "exit">[] | undefined,
): { readonly running: number; readonly failed: number } => {
  const states = (shells ?? []).map(shellStateOf)
  return {
    running: states.filter((state) => state === "running").length,
    failed: states.filter((state) => state === "failed").length,
  }
}
