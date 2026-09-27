import type { TerminalMetadata } from "../model/types"
import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"

export type CloseTerminalDialogProps = {
  // The terminal waiting to close, or null when nothing asks.
  readonly terminal: Pick<TerminalMetadata, "id" | "name" | "process"> | null
  readonly onConfirm: () => void
  readonly onCancel: () => void
  // Where focus goes back when the person keeps the terminal.
  readonly returnFocus: (terminalId: string) => HTMLElement | null
}

// Asks before closing a terminal a program still runs in, since closing ends it.
// Cancel is focused first, as the safe choice; Escape and a click outside cancel too.
export const CloseTerminalDialog = ({
  terminal,
  onConfirm,
  onCancel,
  returnFocus,
}: CloseTerminalDialogProps): React.JSX.Element => (
  <ConfirmDialog
    subject={terminal}
    title={(shown) => `Close “${shown.name}”?`}
    description={(shown) => `${shown.process || "A program"} is still running in it.`}
    confirmLabel="Close terminal"
    cancelLabel="Cancel"
    onConfirm={onConfirm}
    onCancel={onCancel}
    returnFocus={(shown) => returnFocus(shown.id)}
    widthClassName="w-[min(360px,calc(100vw-32px))]"
  />
)
