import { isAgentProgram } from "./process"
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
// idle at its prompt, running a program, waiting on the person, unheard, or ended. An
// agent that reports through its hooks reads as running only while it works, its turn
// or what that left running, and as waiting while it asks for permission or a question.
// An agent NovaDeck hears nothing from, as its hooks aren't connected or trusted, is
// unheard: whether it works or waits, nothing tells. A clean exit closes the terminal, so
// a finished one reads as idle for the moment it remains.
export type TerminalPhase = "starting" | "idle" | "running" | "attention" | "unheard" | "ended"

export const terminalPhase = (terminal: TerminalMetadata): TerminalPhase => {
  if (terminal.state === "exited" || terminal.state === "failed") return "ended"
  if (terminal.state === "starting") return "starting"
  if (terminal.state !== "running") return "idle"
  if (terminal.agent?.attention) return "attention"
  if (!terminal.agent && isAgentProgram(terminal.process)) return "unheard"
  return terminal.agent && !terminal.agent.working ? "idle" : "running"
}

// What the terminal's phase leaves unsaid at a glance, in words for its tooltip and
// assistive technology: that NovaDeck can't hear from its agent. Undefined otherwise.
export const unheardText = (terminal: TerminalMetadata): string | undefined =>
  terminalPhase(terminal) === "unheard"
    ? "Not reporting · NovaDeck can't hear from this agent"
    : undefined

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
