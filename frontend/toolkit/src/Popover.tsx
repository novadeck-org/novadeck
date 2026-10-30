import { Popover as ArkPopover } from "@ark-ui/react/popover"
import { Portal } from "@ark-ui/react/portal"
import { useId, useRef, type ReactElement, type ReactNode } from "react"

import { Tooltip } from "./Tooltip"

export type PopoverProps = {
  readonly label: string
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  // What it opens from. Absent for one opened by something else, which says where it hangs
  // with `anchorRect`.
  readonly trigger?: ReactElement
  // Where it hangs when it has no trigger, read each time it places itself.
  readonly anchorRect?: () => DOMRect | null
  readonly children: ReactNode
  readonly className?: string
  // What its trigger's tooltip says, while the popover is closed. The trigger's Ark data
  // attributes are then the tooltip's: style its open state by aria-expanded.
  readonly tooltip?: string
  // Where it opens from its trigger: below by default, or above for one at the bottom.
  readonly placement?: "bottom-start" | "bottom-end" | "top-end"
  // Where focus lands when it opens, where the first control is not the one to press by reflex;
  // false leaves focus where it is, for one that opens by itself.
  readonly initialFocus?: () => HTMLElement | null | false
  // False leaves where focus goes once it closes to its owner, instead of back to the trigger.
  readonly restoreFocus?: boolean
  // A click or focus outside, which closes it: its owner may tell it from Esc.
  readonly onInteractOutside?: () => void
}

export const Popover = ({
  label,
  open,
  onOpenChange,
  trigger,
  anchorRect,
  children,
  className,
  tooltip,
  placement = "bottom-start",
  initialFocus,
  restoreFocus = true,
  onInteractOutside,
}: PopoverProps): React.JSX.Element => {
  // One id for the trigger, which a tooltip around it shares: the popover places itself
  // and hands focus back by it.
  const triggerId = useId()
  const content = useRef<HTMLDivElement>(null)
  return (
    <ArkPopover.Root
      ids={{ trigger: triggerId }}
      open={open}
      // By default, where focus already is inside: Ark asks on a later frame, and a person may
      // have focused or reordered a row by then; keep that deliberate focus instead of
      // starting at the first row.
      initialFocusEl={
        initialFocus ??
        (() => {
          const active = content.current?.ownerDocument.activeElement
          return active instanceof HTMLElement && content.current?.contains(active) ? active : null
        })
      }
      onOpenChange={({ open: next }) => onOpenChange(next)}
      restoreFocus={restoreFocus}
      {...(onInteractOutside ? { onInteractOutside: () => onInteractOutside() } : {})}
      positioning={{
        placement,
        strategy: "fixed",
        gutter: 10,
        overflowPadding: 12,
        ...(anchorRect ? { getAnchorRect: anchorRect } : {}),
      }}
      lazyMount
      unmountOnExit
    >
      {!trigger ? null : tooltip ? (
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
            ref={content}
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
