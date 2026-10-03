import { Check } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"

import { cn } from "../class-name"

// A checkbox drawn to match the switches: the strong fill with a check once checked
// (the toggle recipe). It sits in a label that names it (or takes `aria-label`) and
// shows its focus, with `has-focus-visible`, around the whole choice.
export const Checkbox = ({
  checked,
  onChange,
  className,
  ...attributes
}: Omit<ComponentPropsWithoutRef<"input">, "type" | "checked" | "onChange" | "className"> & {
  readonly checked: boolean
  readonly onChange: (checked: boolean) => void
  // Places the box; the box itself keeps one look everywhere.
  readonly className?: string
}): React.JSX.Element => (
  <span
    className={cn(
      "checkbox relative flex size-4.5 shrink-0 items-center justify-center",
      className,
    )}
  >
    <input
      {...attributes}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="checkbox-input absolute inset-0 m-0 size-full cursor-[inherit]"
    />
    <Check
      size={12}
      strokeWidth={3}
      aria-hidden="true"
      className="checkbox-mark pointer-events-none relative"
    />
  </span>
)
