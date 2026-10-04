import { HoverCard as ArkHoverCard } from "@ark-ui/react/hover-card"
import { Portal } from "@ark-ui/react/portal"
import { useState, type ReactElement, type ReactNode } from "react"

import { useRestingPointer } from "./resting-pointer"

export type HoverCardProps = {
  trigger: ReactElement
  children: ReactNode
  className?: string
  // Told when the peek opens and when it closes.
  onOpenChange?: (open: boolean) => void
}

// Whether a menu is open anywhere; a peek stays out of its way.
const menuOpen = (): boolean =>
  document.querySelector('[data-scope="menu"][data-part="content"][data-state="open"]') !== null

// How long the pointer rests on a trigger before its peek opens.
const restDelay = 250

// A peek above its trigger, for the pointer: it opens once the pointer rests on the
// trigger and stays while the pointer is on either, so what's in it can be clicked. Focus doesn't open it, so give
// the trigger another way to what the peek offers, such as a menu. Pressing the right
// button closes it before a context menu opens, and it doesn't open over a menu.
export const HoverCard = ({
  trigger,
  children,
  className,
  onOpenChange,
}: HoverCardProps): React.JSX.Element => {
  const [open, show] = useState(false)
  const setOpen = (next: boolean): void => {
    if (next === open) return
    show(next)
    onOpenChange?.(next)
  }
  const resting = useRestingPointer(restDelay, () => {
    if (!menuOpen()) setOpen(true)
  })
  return (
    <ArkHoverCard.Root
      open={open}
      // Resting opens it; Ark only keeps it open, as the pointer moves onto the peek.
      onOpenChange={({ open: next }) => setOpen(next && open)}
      openDelay={restDelay}
      closeDelay={120}
      positioning={{ placement: "top-start", strategy: "fixed", gutter: 8, overflowPadding: 12 }}
      lazyMount
      unmountOnExit
    >
      <ArkHoverCard.Trigger
        asChild
        onPointerMove={resting.handlers.onPointerMove}
        onPointerLeave={resting.handlers.onPointerLeave}
        // The right button, or Control with the left on a Mac, asks for the context menu.
        onPointerDown={(event) => {
          resting.handlers.onPointerDown()
          if (event.button === 2 || (event.button === 0 && event.ctrlKey)) setOpen(false)
        }}
      >
        {trigger}
      </ArkHoverCard.Trigger>
      <Portal>
        <ArkHoverCard.Positioner className="z-40">
          <ArkHoverCard.Content className={`floating peek z-40 ${className ?? ""}`}>
            {children}
          </ArkHoverCard.Content>
        </ArkHoverCard.Positioner>
      </Portal>
    </ArkHoverCard.Root>
  )
}
