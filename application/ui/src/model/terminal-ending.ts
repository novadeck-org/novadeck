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
// An agent Novadeck hears nothing from, as its hooks aren't connected or trusted, is
// unheard: whether it works or waits, nothing tells. A clean exit closes the terminal, so
// a finished one reads as idle for the moment it remains. One idle whose agent finished
// while the person looked elsewhere, its reply `unread`, is done until they look.
export type TerminalPhase =
  | "starting"
  | "idle"
  | "done"
  | "running"
  | "attention"
  | "unheard"
  | "ended"

export const terminalPhase = (terminal: TerminalMetadata, unread = false): TerminalPhase => {
  if (terminal.state === "exited" || terminal.state === "failed") return "ended"
  if (terminal.state === "starting") return "starting"
  if (terminal.state !== "running") return unread ? "done" : "idle"
  if (terminal.agent?.attention) return "attention"
  if (!terminal.agent && isAgentProgram(terminal.process)) return "unheard"
  if (terminal.agent && !terminal.agent.working) return unread ? "done" : "idle"
  return "running"
}

// What a terminal asks of the person: an agent asking a question, waiting on a permission
// or a plan to review, or one that finished while they looked elsewhere, on an error or on
// its own. Most pressing first.
export const terminalAsks = ["question", "permission", "plan", "failed", "done"] as const
export type TerminalAsk = (typeof terminalAsks)[number]

// What the terminal asks, as its phase reads: the kind of request it waits on, or, as its
// reply is unread (`end`, how that turn ended), the way it finished. Undefined otherwise,
// as for a request over an unread reply, or an ended terminal.
export const terminalAsk = (
  terminal: TerminalMetadata,
  end?: "done" | "failed",
): TerminalAsk | undefined => {
  const phase = terminalPhase(terminal, end !== undefined)
  if (phase === "attention")
    return terminal.state === "running" ? terminal.agent?.attention?.kind : undefined
  return phase === "done" ? end : undefined
}

// What a done terminal says, in words for its tab's description, its window and assistive
// technology: done, or stopped on an error, its reply unread either way.
export const doneText = (failed = false): string =>
  failed ? "Stopped with an error · reply unread" : "Done · reply unread"

// What the terminal's phase leaves unsaid at a glance, in words for its tooltip and
// assistive technology: that Novadeck can't hear from its agent. Undefined otherwise.
export const unheardText = (terminal: TerminalMetadata): string | undefined =>
  terminalPhase(terminal) === "unheard"
    ? "Not reporting · Novadeck can't hear from this agent"
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
