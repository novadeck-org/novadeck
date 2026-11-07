import { closeReasons, type CloseReason } from "@novadeck/core/terminals/closing"
import { handleText } from "@novadeck/core/terminals/handle"
import type { TerminalMetadata } from "@novadeck/core/types"
import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"

type CloseTerminalDialogProps = {
  // The terminal waiting to close, or null when nothing asks.
  readonly terminal: TerminalMetadata | null
  // Whether closing can be undone from History, which changes what is worth asking about.
  readonly keepsHistory: boolean
  readonly onConfirm: () => void
  readonly onCancel: () => void
  // Where focus goes back when the person keeps the terminal.
  readonly returnFocus: (terminalId: string) => HTMLElement | null
}

const sentences = (terminal: TerminalMetadata): Readonly<Record<CloseReason, string>> => ({
  program: `${terminal.process || "A program"} is still running in it.`,
  working: "Its agent is working on a turn, and closing it stops the turn.",
  unrestorable: "It can't be restored from History once it is closed.",
})

// Asks before closing a terminal that would lose something: a program still running in it,
// or, where History keeps closed terminals, an agent mid-turn or one that can't be restored.
// Cancel is focused first, as the safe choice; Escape and a click outside cancel too.
export const CloseTerminalDialog = ({
  terminal,
  keepsHistory,
  onConfirm,
  onCancel,
  returnFocus,
}: CloseTerminalDialogProps): React.JSX.Element => (
  <ConfirmDialog
    subject={terminal}
    title={(shown) =>
      `Close ${shown.handle ? `${handleText(shown.handle)} · ` : ""}“${shown.name}”?`
    }
    description={(shown) =>
      closeReasons(shown, keepsHistory)
        .map((reason) => sentences(shown)[reason])
        .join(" ") || sentences(shown).program
    }
    confirmLabel="Close terminal"
    cancelLabel="Cancel"
    onConfirm={onConfirm}
    onCancel={onCancel}
    returnFocus={(shown) => returnFocus(shown.id)}
    widthClassName="w-[min(360px,calc(100vw-32px))]"
  />
)
