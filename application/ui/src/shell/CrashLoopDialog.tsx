import { ConfirmDialog } from "../ui-toolkit/ConfirmDialog"

// Tells the person the backend stopped restarting their terminals after repeated crashes,
// and offers to try again. "Try again" is focused first, as retrying is the safe choice;
// "Not now", Escape and a click outside leave it until the next crash loop.
export const CrashLoopDialog = ({
  crashes,
  onRetry,
  onDismiss,
}: {
  // Crashes counted in the last minute; the dialog is open while this is set.
  readonly crashes: number | null
  readonly onRetry: () => void
  readonly onDismiss: () => void
}): React.JSX.Element => (
  <ConfirmDialog
    subject={crashes}
    title={() => "The runner keeps crashing"}
    description={(count) =>
      `NovaDeck stopped restarting your terminals after ${count} crashes in a minute.`
    }
    confirmLabel="Try again"
    cancelLabel="Not now"
    onConfirm={onRetry}
    onCancel={onDismiss}
    focus="confirm"
    widthClassName="w-[min(380px,calc(100vw-32px))]"
  />
)
