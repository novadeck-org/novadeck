import { SegmentGroup as ArkSegmentGroup } from "@ark-ui/react/segment-group"
import { useId, type ReactNode } from "react"

import { cn } from "../class-name"
import { Tooltip } from "./Tooltip"

export type SegmentOption = {
  value: string
  label: string
  icon?: ReactNode
}

export type SegmentGroupProps = {
  label: string
  tooltips?: boolean
  items: SegmentOption[]
  value: string
  onValueChange: (value: string) => void
  className?: string
  itemClassName?: string
  // The active item's look, drawn behind the items and sliding between them.
  indicatorClassName?: string
}

export const SegmentGroup = ({
  label,
  tooltips = false,
  items,
  value,
  onValueChange,
  className,
  itemClassName,
  indicatorClassName,
}: SegmentGroupProps): React.JSX.Element => {
  const id = useId()
  const itemId = (item: string): string => `${id}:${item}`
  return (
    <ArkSegmentGroup.Root
      id={id}
      ids={{ item: itemId }}
      orientation="horizontal"
      aria-label={label}
      className={cn("relative", className)}
      value={value}
      onValueChange={(details) => {
        if (details.value !== null) onValueChange(details.value)
      }}
    >
      {items.map((item) => (
        <Tooltip key={item.value} content={item.label} disabled={!tooltips}>
          <ArkSegmentGroup.Item
            id={itemId(item.value)}
            value={item.value}
            className={cn(
              "relative z-1 cursor-pointer transition-[background-color,color,border-color] duration-(--motion-feedback) ease-interface data-focus-visible:outline data-focus-visible:outline-2 data-focus-visible:outline-strong data-focus-visible:outline-offset-2",
              itemClassName,
              value === item.value &&
                (indicatorClassName
                  ? "active bg-transparent text-ink hover:bg-transparent"
                  : "active border-line bg-paper text-ink shadow-control"),
            )}
          >
            {item.icon}
            <ArkSegmentGroup.ItemText>{item.label}</ArkSegmentGroup.ItemText>
            <ArkSegmentGroup.ItemControl className="sr-only" />
            <ArkSegmentGroup.ItemHiddenInput aria-label={item.label} />
          </ArkSegmentGroup.Item>
        </Tooltip>
      ))}
      {indicatorClassName && (
        <ArkSegmentGroup.Indicator
          className={cn(
            "pointer-events-none top-(--top) z-0 h-(--height) w-(--width) [--transition-duration:var(--motion-state)] [--transition-timing-function:var(--ease-interface)]",
            indicatorClassName,
          )}
        />
      )}
    </ArkSegmentGroup.Root>
  )
}
