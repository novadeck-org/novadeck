import type { TerminalMetadata } from "../types"
import { isAgentProgram } from "./process"
import { clockTime, waitingOf, waitingText as waitingNote } from "./waiting"

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
// its hooks reads as running only while it works, its turn or what that left running. An
// agent Novadeck hears nothing from, as its hooks aren't connected or trusted, is unheard:
// whether it works or waits, nothing tells. A clean exit closes the terminal, so a finished
// one reads as idle for the moment it remains.
//
// `outcome` is what the caller says is unseen and final: a report the agent made itself
// (its MCP `done` call) or a turn that stopped on an error, never a turn that merely ended.
// A reply the person hasn't read leaves an idle agent idle, for its tab to brighten its
// program. A dialog the agent waits on (`attention`) rests it too, but for a request it
// asked without waiting, which it works on through. A limit pauses an agent that stopped on
// one until it works again. What an agent needs of the person, a dialog or a question, is
// no phase: see `terminalNeedMark`.
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

// Whether a dialog its agent shows holds it: a request that asks without waiting holds
// nothing, as the agent works on.
export const heldByDialog = (terminal: TerminalMetadata): boolean =>
  terminal.state === "running" &&
  terminal.agent?.attention !== undefined &&
  terminal.agent.attention.detached !== true

export const terminalPhase = (
  terminal: TerminalMetadata,
  outcome = false,
  now = Date.now(),
): TerminalPhase => {
  if (terminal.state === "exited" || terminal.state === "failed") return "ended"
  if (terminal.state === "starting") return "starting"
  if (terminal.state !== "running") return outcome ? "done" : "idle"
  if (!terminal.agent && isAgentProgram(terminal.process)) return "unheard"
  // A dialog it shows stops it: its harness keeps the turn open, but nothing works until the
  // person answers, so it rests as far as the glyph and the window's line say.
  if (terminal.agent && (!terminal.agent.working || heldByDialog(terminal))) {
    if (pausedUntil(terminal) !== undefined) return "paused"
    if (outcome) return "done"
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
    (terminal) => terminalPhase(terminal, false, now) === "waiting" && !heldByDialog(terminal),
  )

// What a terminal needs of the person, for the mark right after its program: `unblock` (a
// permission, a plan, a held message, an action only they can do) or `ask` (a question).
export type TerminalNeed = "unblock" | "ask"

// What a dialog its agent shows now needs, which shows at once, before the Inbox's row:
// a question asks, a permission or a plan unblocks.
const attentionNeed = (terminal: TerminalMetadata): TerminalNeed | undefined => {
  const attention = terminal.state === "running" ? terminal.agent?.attention : undefined
  if (!attention) return undefined
  return attention.kind === "question" ? "ask" : "unblock"
}

// The mark: the need the Inbox's rows make (`terminalNeed` in inbox.ts) and the one its
// live dialog makes, an unblock winning.
export const terminalNeedMark = (
  terminal: TerminalMetadata,
  inbox?: TerminalNeed,
): TerminalNeed | undefined =>
  inbox === "unblock" || attentionNeed(terminal) === "unblock"
    ? "unblock"
    : (inbox ?? attentionNeed(terminal))

// What a done terminal says, in words for its tab's description, its window and assistive
// technology: it reported its task done, which stands until the person or a message gives
// it more to do, or its turn stopped on an error, until the person looks.
export const doneText = (failed = false): string =>
  failed ? "Stopped with an error · reply unread" : "Done · reported"

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

// The kind of dialog a need comes from: what the agent's harness shows, or the request an
// Inbox row stands for.
export type NeedDialog = "permission" | "question" | "plan"

const dialogLead: Record<NeedDialog, string> = {
  question: "Asks",
  permission: "Needs permission",
  plan: "Plan ready for review",
}

const dialogBare: Record<NeedDialog, string> = { ...dialogLead, question: "Asks a question" }

// What a terminal needs, in words for its description, from whichever source decided its mark
// (`terminalNeedMark`). The kind comes first and the subject of the Inbox's row after it
// where there is one: "Needs permission: pnpm test …", "Plan ready for review: Checkout flow",
// "Asks: Where should feedback go?", "Needs you: wrangler login" for a row that is no dialog
// (a held message, a sign-in, a limit). The kind is the row's own (`dialog`) while the Inbox
// decided the mark, so the words keep their kind from the dialog's first moment, before the
// Inbox's row, to the row. With no subject: what the live dialog says when it decided the mark
// (as in "Plan ready for review"), else the row's kind, else the need alone. `inbox` is the
// Inbox's need, not the mark.
export const needText = (
  terminal: TerminalMetadata,
  inbox: TerminalNeed | undefined,
  subject?: string,
  dialog?: NeedDialog,
): string | undefined => {
  const need = terminalNeedMark(terminal, inbox)
  if (!need) return undefined
  const fromInbox = inbox === need
  const kind = fromInbox ? dialog : undefined
  if (fromInbox && subject) {
    const lead = kind ? dialogLead[kind] : need === "ask" ? "Asks" : "Needs you"
    return `${lead}: ${subject}`
  }
  if (attentionNeed(terminal) === need) return attentionText(terminal)
  if (kind) return dialogBare[kind]
  return need === "ask" ? "Asks a question" : "Needs you"
}

// What the Inbox says of one terminal, for its tab, its window and its project's status: the
// need its rows make, and the subject and the dialog kind of the row that makes the need
// (`inboxMarks` in inbox/marks.ts). Its done report is no mark of the Inbox: it stands with
// the agent (`AgentStatus.reported`).
export type InboxMarks = {
  readonly need: TerminalNeed | undefined
  readonly subject?: string | undefined
  readonly dialog?: NeedDialog | undefined
}

// How a terminal reads at a glance, once, for its tab, its window and its project's status, so
// that they cannot drift apart.
export type TerminalGlance = {
  readonly phase: TerminalPhase
  // The mark after the program: none for an ended terminal.
  readonly need: TerminalNeed | undefined
  // Its final outcome shows as a stopped turn rather than a report.
  readonly failed: boolean
  // A reply the person hasn't read, on an agent that rests: its program brightens.
  readonly brightened: boolean
}

// `unread` is how the terminal's last turn ended while the person looked away, if it did.
export const terminalGlance = (
  terminal: TerminalMetadata,
  marks: InboxMarks,
  unread: "unread" | "failed" | undefined,
  now = Date.now(),
): TerminalGlance => {
  const failed = unread === "failed"
  const reported = terminal.state === "running" && terminal.agent?.reported === true
  const phase = terminalPhase(terminal, reported || failed, now)
  return {
    phase,
    need: phase === "ended" ? undefined : terminalNeedMark(terminal, marks.need),
    failed,
    brightened: unread === "unread" && phase === "idle",
  }
}

// The glance with its description, in words for assistive technology and the tab's tooltip:
// what the terminal needs, then whichever of these describes it first: not reporting, paused at
// its limit, waiting on something that wakes it, done, a reply unread. Undefined text when it
// says nothing.
export type TerminalNote = TerminalGlance & { readonly text: string | undefined }

// The note of what has no terminal to read, as a window that runs no program.
export const idleNote: TerminalNote = {
  phase: "idle",
  need: undefined,
  failed: false,
  brightened: false,
  text: undefined,
}

export const terminalNote = (
  terminal: TerminalMetadata,
  marks: InboxMarks,
  unread: "unread" | "failed" | undefined,
  now = Date.now(),
): TerminalNote => {
  const glance = terminalGlance(terminal, marks, unread, now)
  const { phase, failed, brightened } = glance
  const text = joinNote([
    needText(terminal, marks.need, marks.subject, marks.dialog),
    unheardText(terminal) ??
      (phase === "paused" ? pausedText(terminal, now) : undefined) ??
      (phase === "waiting" ? waitingNote(terminal, now) : undefined) ??
      (phase === "done" ? doneText(failed) : undefined) ??
      (brightened ? "Reply unread" : undefined),
  ])
  return { ...glance, text: text || undefined }
}
