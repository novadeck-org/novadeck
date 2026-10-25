import { clockTime, waitingOf } from "./agent-waiting"
import { isAgentProgram } from "./process"
import type { TerminalMetadata } from "./types"

// How a terminal's session ended, in words for its end-of-session bar and its sidebar
// tab. The tone ranks it: a warning for a shell that exited with an error code, danger
// for one killed or that never started. A terminal still starting, running or idle has
// none; a clean exit closes it.
export type TerminalEnding = {
  readonly tone: "danger" | "warning"
  readonly status: string
  // Why, where known: the code, the signal or running out of memory, or what stopped it
  // starting.
  readonly reason: string | null
}

export const terminalEnding = (terminal: TerminalMetadata): TerminalEnding | null => {
  if (terminal.state === "exited") {
    if (terminal.signal)
      return {
        tone: "danger",
        status: "Killed",
        reason: terminal.cause === "out-of-memory" ? "out of memory" : terminal.signal,
      }
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

// What a terminal shows at a glance, in its tab and on its window, as the state of what it
// does: a shell starting, idle at its prompt, running a program, waiting on something that
// wakes it, paused at a usage limit, done, unheard, or ended. An agent that reports through
// its hooks reads as running only while it works, its turn or what that left running.
// An agent Novadeck hears nothing from, as its hooks aren't connected or trusted, is
// unheard: whether it works or waits, nothing tells. A clean exit closes the terminal, so a
// finished one reads as idle for the moment it remains.
//
// `done` is what the caller says is unseen and final: a report the agent made itself (its
// MCP `done` call) or a turn that stopped on an error, never a turn that merely ended. A
// reply the person hasn't read leaves an idle agent idle, for its tab to brighten its
// program. A dialog the agent waits on (`attention`) rests it too. A limit pauses an agent that stopped on one until it works again. What an agent
// needs of the person, a dialog or an ask, is no phase: see `terminalNeedMark`.
export type TerminalPhase =
  | "starting"
  | "idle"
  | "done"
  | "running"
  | "waiting"
  | "paused"
  | "unheard"
  | "ended"

// When the usage limit an agent is paused at resets, in epoch milliseconds: set while its
// last turn ended on a limit with a known window and the agent does not work.
export const pausedUntil = (terminal: TerminalMetadata): number | undefined =>
  terminal.state === "running" && terminal.agent && !terminal.agent.working
    ? terminal.agent.lastTurn?.limit?.resetsAt
    : undefined

export const terminalPhase = (
  terminal: TerminalMetadata,
  done = false,
  now = Date.now(),
): TerminalPhase => {
  if (terminal.state === "exited" || terminal.state === "failed") return "ended"
  if (terminal.state === "starting") return "starting"
  if (terminal.state !== "running") return done ? "done" : "idle"
  if (!terminal.agent && isAgentProgram(terminal.process)) return "unheard"
  // A dialog it shows stops it: its harness keeps the turn open, but nothing works until the
  // person answers, so it rests as far as the glyph and the window's line say.
  if (terminal.agent && (!terminal.agent.working || terminal.agent.attention)) {
    if (pausedUntil(terminal) !== undefined) return "paused"
    if (done) return "done"
    return waitingOf(terminal, now) ? "waiting" : "idle"
  }
  return "running"
}

// The terminals whose agent has ended its turn to wait on something that wakes it, which
// the footer counts apart from those at work. One held on a dialog waits on the person
// instead, so it isn't among them.
export const waitingAgents = (
  terminals: readonly TerminalMetadata[],
  now = Date.now(),
): TerminalMetadata[] =>
  terminals.filter(
    (terminal) =>
      terminalPhase(terminal, false, now) === "waiting" &&
      !(terminal.state === "running" && terminal.agent?.attention),
  )

// What a terminal needs of the person, for the mark right after its program: `unblock` (a
// permission, a plan, a held message, an action only they can do) or `ask` (a question).
export type TerminalNeed = "unblock" | "ask"

// What a dialog its agent shows now needs, which shows at once, before the Inbox's row:
// a question asks, a permission or a plan unblocks.
export const attentionNeed = (terminal: TerminalMetadata): TerminalNeed | undefined => {
  const attention = terminal.state === "running" ? terminal.agent?.attention : undefined
  if (!attention) return undefined
  return attention.kind === "question" ? "ask" : "unblock"
}

// The mark: the need the Inbox's items make (`terminalNeed` in inbox.ts) and the one its
// live dialog makes, an unblock winning.
export const terminalNeedMark = (
  terminal: TerminalMetadata,
  inbox?: TerminalNeed,
): TerminalNeed | undefined =>
  inbox === "unblock" || attentionNeed(terminal) === "unblock"
    ? "unblock"
    : (inbox ?? attentionNeed(terminal))

// What a done terminal says, in words for its tab's description, its window and assistive
// technology: it reported its task done, or its turn stopped on an error, until the person
// looks.
export const doneText = (failed = false): string =>
  failed ? "Stopped with an error · reply unread" : "Done · report unread"

// What a paused agent says: it stopped at its usage limit, with when it resets as the clock
// reads it ("Paused at its usage limit · resets 15:40"), or, once that time has passed, that
// the limit has reset and it waits to be continued.
export const pausedText = (terminal: TerminalMetadata, now = Date.now()): string | undefined => {
  const at = pausedUntil(terminal)
  if (at === undefined) return undefined
  return at <= now
    ? "Paused at its usage limit · it has reset and waits to be continued"
    : `Paused at its usage limit · resets ${clockTime(at)}`
}

// Joins the parts of a tab's or window's description into one sentence: a part after the
// first reads on from it, so it isn't capitalised ("Needs you, paused at its usage limit ·
// resets 15:40").
export const joinNote = (parts: readonly (string | undefined)[]): string =>
  parts
    .filter((part): part is string => !!part)
    .map((part, index) => (index === 0 ? part : part.charAt(0).toLowerCase() + part.slice(1)))
    .join(", ")

// What the terminal's phase leaves unsaid at a glance, in words for its tooltip and
// assistive technology: that Novadeck can't hear from its agent. Undefined otherwise.
export const unheardText = (terminal: TerminalMetadata): string | undefined =>
  terminalPhase(terminal) === "unheard"
    ? "Not reporting · Novadeck can't hear from this agent"
    : undefined

// What waits on the person, with how many do when several: "Asks a question · 2 waiting".
const waitingText = (what: string, count: number): string =>
  count > 1 ? `${what} · ${count} waiting` : what

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
  return waitingText(what, attention.count)
}

// What a terminal needs, in words for its description: what it asks or needs, with the
// Inbox item's subject where there is one ("Asks: Where should feedback go?"), else what
// its dialog says, else the need alone.
export const needText = (
  terminal: TerminalMetadata,
  need: TerminalNeed | undefined,
  subject?: string,
): string | undefined => {
  if (!need) return undefined
  if (subject) return `${need === "ask" ? "Asks" : "Needs you"}: ${subject}`
  return attentionText(terminal) ?? (need === "ask" ? "Asks a question" : "Needs you")
}
