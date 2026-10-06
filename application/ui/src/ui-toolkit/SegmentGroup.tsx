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
  disabled?: boolean
  className?: string
  // Arranges each item; the segmented recipe draws it.
  itemClassName?: string
  // Draws the active item's look behind the items, sliding between them, instead of on
  // the active item; the class places it.
  indicatorClassName?: string
}

export const SegmentGroup = ({
  label,
  tooltips = false,
  items,
  value,
  onValueChange,
  disabled,
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
      className={cn("segmented relative", className)}
      value={value}
      disabled={disabled}
      onValueChange={(details) => {
        if (details.value !== null) onValueChange(details.value)
      }}
    >
      {items.map((item) => (
        <Tooltip key={item.value} content={item.label} disabled={!tooltips}>
          <ArkSegmentGroup.Item
            id={itemId(item.value)}
            value={item.value}
            className={cn("segment relative z-1 cursor-pointer", itemClassName)}
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
            "segmented-indicator pointer-events-none top-(--top) z-0 h-(--height) w-(--width)",
            indicatorClassName,
          )}
        />
      )}
    </ArkSegmentGroup.Root>
  )
}
