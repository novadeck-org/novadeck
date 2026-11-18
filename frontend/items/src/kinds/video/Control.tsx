import { Tooltip } from "@novadeck/toolkit/Tooltip"
import type { LucideIcon } from "lucide-react"

// A control of a player's bar: an icon button with its tooltip, as the pane's tools are.
export const Control = ({
  icon: Icon,
  label,
  tip,
  onClick,
  pressed,
  name,
}: {
  icon: LucideIcon
  label: string
  tip: string
  onClick: () => void
  pressed?: boolean
  name: string
}): React.JSX.Element => (
  <Tooltip content={tip}>
    <button
      type="button"
      className="icon-button video-control"
      data-control={name}
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
    >
      <Icon size={14} strokeWidth={1.75} aria-hidden />
    </button>
  </Tooltip>
)
