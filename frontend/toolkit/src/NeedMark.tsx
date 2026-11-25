import { BellOff } from "lucide-react"

// What something in a row needs of the person: it can't go on without them, it asks, or that is
// snoozed.
export type Need = "unblock" | "ask" | "snoozed"

// The mark right after what a row names (need-mark.css): `!`, `?`, or a bell-off. With `hidden`
// it is hidden from assistive technology, for a row that says the need in words; otherwise a
// screen reader reads its `!` or `?`.
export const NeedMark = ({
  need,
  hidden = false,
  className = "",
}: {
  readonly need: Need
  readonly hidden?: boolean
  readonly className?: string
}): React.JSX.Element => (
  <span
    {...(hidden ? { "aria-hidden": true } : {})}
    className={`need-mark shrink-0 ${className}`.trimEnd()}
    data-need={need}
  >
    {need === "snoozed" ? <BellOff size={11} strokeWidth={2} /> : need === "unblock" ? "!" : "?"}
  </span>
)
