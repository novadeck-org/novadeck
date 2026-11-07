import { closeReasons, type CloseReason } from "@novadeck/core/terminals/closing"
import { handleText } from "@novadeck/core/terminals/handle"
import type { TerminalMetadata } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"

type CloseTerminalDialogProps = {
  // The terminal waiting to close, or null when nothing asks.
  readonly terminal: TerminalMetadata | null
  // Whether closing can be undone from History, which changes what is worth asking about.
  readonly keepsHistory: boolean
  // Every terminal of its session, to see whom it leads.
  readonly terminals: readonly TerminalMetadata[]
  readonly onConfirm: () => void
  readonly onCancel: () => void
  // Where focus goes back when the person keeps the terminal.
  readonly returnFocus: (terminalId: string) => HTMLElement | null
}

// What a sleeping or waking agent's terminal says: where the agent is, with its session saved.
const restingWords = (terminal: TerminalMetadata, then: string): string | undefined =>
  terminal.state === "sleeping"
    ? `${terminal.agent} is asleep in it, with its session saved, but ${then}`
    : terminal.state === "starting" && terminal.restoredProcess
      ? `${terminal.restoredProcess} is waking in it, with its session saved, but ${then}`
      : undefined

const sentences = (terminal: TerminalMetadata): Readonly<Record<CloseReason, string>> => ({
  program: `${terminal.process || "A program"} is still running in it.`,
  working: "Its agent is working on a turn, and closing it stops the turn.",
  background:
    "Its agent is waiting on a job or a wake-up it set, or has tasks running in the background. Closing it ends them, and restoring it doesn't start them again.",
  leads:
    "It leads other agents that are still running. Closing it leaves them without a lead, and restoring it doesn't give the lead back.",
  unrestorable:
    restingWords(terminal, "its session can't be restored from History once it is closed.") ??
    "It can't be restored from History once it is closed.",
  asleep: restingWords(terminal, "closing it ends that session.") ?? "",
})

// What the dialog says, from the terminal as it is now: an agent's turn may end, or a program
// exit, while the question is up, and then nothing is left to lose.
export const closeDescription = (
  terminal: TerminalMetadata,
  keepsHistory: boolean,
  terminals: readonly TerminalMetadata[] = [],
): string => {
  const reasons = closeReasons(terminal, keepsHistory, terminals)
  if (reasons.length > 0) return reasons.map((reason) => sentences(terminal)[reason]).join(" ")
  return keepsHistory
    ? "Nothing in it is running now. It stays in History, so it can be restored."
    : sentences(terminal).program
}

// Asks before closing a terminal that would lose something: a program still running in it,
// or, where History keeps closed terminals, an agent mid-turn, one waiting on background
// jobs, one that leads running agents, or one that can't be restored.
// Cancel is focused first, as the safe choice; Escape and a click outside cancel too.
export const CloseTerminalDialog = ({
  terminal,
  keepsHistory,
  terminals,
  onConfirm,
  onCancel,
  returnFocus,
}: CloseTerminalDialogProps): React.JSX.Element => (
  <ConfirmDialog
    subject={terminal}
    title={(shown) =>
      `Close ${shown.handle ? `${handleText(shown.handle)} · ` : ""}“${shown.name}”?`
    }
    description={(shown) => closeDescription(shown, keepsHistory, terminals)}
    confirmLabel="Close terminal"
    cancelLabel="Cancel"
    onConfirm={onConfirm}
    onCancel={onCancel}
    returnFocus={(shown) => returnFocus(shown.id)}
    widthClassName="w-[min(360px,calc(100vw-32px))]"
  />
)
