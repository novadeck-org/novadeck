import type { MarkPhase } from "./mark-phase"

// The person's mark in the gutter: Novadeck's block cursor, drawn, so it is the same shape in
// every font. It stands still, but for the current turn's prompt, which wears the window's phase
// (`phase`). Hollow, it marks a prompt that isn't theirs: the doorbell's.
export const Mark = ({
  hollow = false,
  phase,
}: {
  readonly hollow?: boolean
  readonly phase?: MarkPhase | undefined
}): React.JSX.Element => (
  <span className="chat-mark" data-hollow={hollow || undefined} data-phase={phase} aria-hidden />
)
