import type { TerminalMetadata } from "./types"

// How a terminal's session ended, in words for its end-of-session bar and its sidebar
// tab. The tone ranks it: a warning for a shell that exited with an error code, danger
// for one killed or that never started. A terminal still starting, running or idle has
// none; a clean exit closes it.
export type TerminalEnding = {
  readonly tone: "danger" | "warning"
  readonly status: string
  // Why, where known: the code, the signal, or what stopped it starting.
  readonly reason: string | null
}

export const terminalEnding = (terminal: TerminalMetadata): TerminalEnding | null => {
  if (terminal.state === "exited") {
    if (terminal.signal) return { tone: "danger", status: "Killed", reason: terminal.signal }
    return {
      tone: "warning",
      status: "Exited",
      reason: terminal.exitCode === null ? null : `code ${terminal.exitCode}`,
    }
  }
  if (terminal.state === "failed")
    return {
      tone: "danger",
      status: "Failed to start",
      reason: terminal.message.replace(/\.$/, "") || null,
    }
  return null
}

// The ending in one line, e.g. "Exited · code 1".
export const endingText = ({ status, reason }: TerminalEnding): string =>
  reason ? `${status} · ${reason}` : status

// What a terminal shows at a glance, in its tab and on its window: a shell starting,
// idle at its prompt, running a program, waiting on the person, or ended. An agent that
// reports through its hooks reads as running only while it works, and as waiting while
// it asks for permission or a question. A clean exit closes the terminal, so a finished
// one reads as idle for the moment it remains.
export type TerminalPhase = "starting" | "idle" | "running" | "attention" | "ended"

export const terminalPhase = (terminal: TerminalMetadata): TerminalPhase => {
  if (terminal.state === "exited" || terminal.state === "failed") return "ended"
  if (terminal.state === "starting") return "starting"
  if (terminal.state !== "running") return "idle"
  if (terminal.agent?.attention) return "attention"
  return terminal.agent && !terminal.agent.working ? "idle" : "running"
}

// What the agent in a terminal waits on the person for, in a few words; undefined when
// nothing waits.
export const attentionText = (terminal: TerminalMetadata): string | undefined => {
  const attention = terminal.state === "running" ? terminal.agent?.attention : undefined
  if (!attention) return undefined
  const what =
    attention.kind === "question"
      ? "Asks a question"
      : attention.kind === "plan"
        ? "Plan ready for review"
        : "Needs permission"
  return attention.count > 1 ? `${what} · ${attention.count} waiting` : what
}
