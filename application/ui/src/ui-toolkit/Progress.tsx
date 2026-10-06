import { Progress as ArkProgress } from "@ark-ui/react/progress"

import { cn } from "../class-name"

// A bar for work of a known size: `value` of `max`. The label names it for assistive
// technology; the caller shows the numbers where it wants them.
export const Progress = ({
  label,
  value,
  max,
  className,
}: {
  readonly label: string
  readonly value: number
  readonly max: number
  readonly className?: string
}): React.JSX.Element => (
  <ArkProgress.Root
    value={Math.min(value, max)}
    min={0}
    max={Math.max(max, 1)}
    aria-label={label}
    className={cn("w-full", className)}
  >
    <ArkProgress.Track className="progress-track h-1.5">
      <ArkProgress.Range className="progress-range" />
    </ArkProgress.Track>
  </ArkProgress.Root>
)
