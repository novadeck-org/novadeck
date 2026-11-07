import { ConfirmDialog } from "@novadeck/toolkit/ConfirmDialog"
import { SubjectBar, SubjectDetail, SubjectName, SubjectSide } from "@novadeck/toolkit/SubjectBar"
import { Terminal } from "lucide-react"

const crashBar = (count: number): React.JSX.Element => (
  <SubjectBar>
    <SubjectSide>
      <Terminal size={14} strokeWidth={1.5} aria-hidden="true" />
      <SubjectName>Runner</SubjectName>
    </SubjectSide>
    <SubjectDetail end>{count} crashes in a minute</SubjectDetail>
  </SubjectBar>
)

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
    bar={crashBar}
    title={() => "It keeps crashing"}
    description={() => "Novadeck stopped restarting your terminals."}
    confirmLabel="Try again"
    cancelLabel="Not now"
    onConfirm={onRetry}
    onCancel={onDismiss}
    focus="confirm"
    widthClassName="w-[min(380px,calc(100vw-32px))]"
  />
)
