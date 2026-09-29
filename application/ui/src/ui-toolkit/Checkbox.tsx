import { Check } from "lucide-react"
import type { ComponentPropsWithoutRef } from "react"

import { cn } from "../class-name"

import styles from "./Checkbox.module.css"

// A checkbox drawn to match the switches: a graphite fill with a white check once
// checked. It sits in a label that names it (or takes `aria-label`) and shows its
// focus, with `has-focus-visible`, around the whole choice.
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
  <span className={cn("relative flex size-4.5 shrink-0 items-center justify-center", className)}>
    <input
      {...attributes}
      type="checkbox"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
      className="peer absolute inset-0 m-0 size-full cursor-[inherit] appearance-none rounded-[4px] border-[1.5px] border-line-strong bg-paper shadow-[inset_0_1px_1px_rgb(21_24_28/0.05)] transition-[background-color,border-color] duration-(--motion-feedback) ease-interface hover:border-muted checked:border-strong checked:bg-strong checked:shadow-none disabled:opacity-45 disabled:hover:border-line-strong disabled:checked:hover:border-strong focus-visible:outline-none"
    />
    <Check
      size={12}
      strokeWidth={3}
      aria-hidden="true"
      className={`${styles.check} pointer-events-none relative text-white`}
    />
  </span>
)
