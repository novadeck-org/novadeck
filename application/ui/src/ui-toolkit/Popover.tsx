import { Popover as ArkPopover } from "@ark-ui/react/popover"
import { Portal } from "@ark-ui/react/portal"
import type { ReactElement, ReactNode } from "react"

export type PopoverProps = {
  label: string
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: ReactElement
  children: ReactNode
  className?: string
}

export const Popover = ({
  label,
  open,
  onOpenChange,
  trigger,
  children,
  className,
}: PopoverProps): React.JSX.Element => (
  <ArkPopover.Root
    open={open}
    onOpenChange={({ open: next }) => onOpenChange(next)}
    positioning={{ placement: "bottom-start", strategy: "fixed", gutter: 10, overflowPadding: 12 }}
    lazyMount
    unmountOnExit
  >
    <ArkPopover.Trigger asChild>{trigger}</ArkPopover.Trigger>
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
