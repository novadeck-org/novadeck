import { Popover as ArkPopover } from "@ark-ui/react/popover"
import { Portal } from "@ark-ui/react/portal"
import { useId, type ReactElement, type ReactNode } from "react"

import { Tooltip } from "./Tooltip"

export type PopoverProps = {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  children: ReactNode
  className?: string
  // What its trigger's tooltip says, while the popover is closed. The trigger's Ark data
  // attributes are then the tooltip's: style its open state by aria-expanded.
  tooltip?: string
}

export const Popover = ({
  label,
  open,
  onOpenChange,
  trigger,
  children,
  className,
  tooltip,
}: PopoverProps): React.JSX.Element => {
  // One id for the trigger, which a tooltip around it shares: the popover places itself
  // and hands focus back by it.
  const triggerId = useId()
  return (
    <ArkPopover.Root
      ids={{ trigger: triggerId }}
      open={open}
      onOpenChange={({ open: next }) => onOpenChange(next)}
      positioning={{
        placement: "bottom-start",
        strategy: "fixed",
        gutter: 10,
        overflowPadding: 12,
      }}
      lazyMount
      unmountOnExit
    >
      {tooltip ? (
        <Tooltip content={tooltip} disabled={open}>
          <ArkPopover.Trigger asChild id={triggerId}>
            {trigger}
          </ArkPopover.Trigger>
        </Tooltip>
      ) : (
        <ArkPopover.Trigger asChild>{trigger}</ArkPopover.Trigger>
      )}
      <Portal>
        <ArkPopover.Positioner className="z-40">
          <ArkPopover.Content
            aria-label={label}
            className={`floating z-40 max-h-(--available-height) overflow-y-auto ${className ?? ""}`}
          >
            {children}
          </ArkPopover.Content>
        </ArkPopover.Positioner>
      </Portal>
    </ArkPopover.Root>
  )
}
