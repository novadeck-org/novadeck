import { HoverCard as ArkHoverCard } from "@ark-ui/react/hover-card"
import { Portal } from "@ark-ui/react/portal"
import { useRef, useState, type ReactElement, type ReactNode } from "react"

export type HoverCardProps = {
  trigger: ReactElement
  children: ReactNode
  className?: string
}

// Whether a menu is open anywhere; a peek stays out of its way.
const menuOpen = (): boolean =>
  document.querySelector('[data-scope="menu"][data-part="content"][data-state="open"]') !== null

// A peek above its trigger, for the pointer: it opens on hover and stays while the
// pointer is on either, so what's in it can be clicked. Focus doesn't open it, so give
// the trigger another way to what the peek offers, such as a menu. Pressing the right
// button closes it before a context menu opens, and it doesn't open over a menu.
export const HoverCard = ({ trigger, children, className }: HoverCardProps): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const hovering = useRef(false)
  return (
    <ArkHoverCard.Root
      open={open}
      onOpenChange={({ open: next }) =>
        setOpen(next && (open || (hovering.current && !menuOpen())))
      }
      openDelay={250}
      closeDelay={120}
      positioning={{ placement: "top-start", strategy: "fixed", gutter: 8, overflowPadding: 12 }}
      lazyMount
      unmountOnExit
    >
      <ArkHoverCard.Trigger
        asChild
        onPointerEnter={() => {
          hovering.current = true
        }}
        onPointerLeave={() => {
          hovering.current = false
        }}
        // The right button, or Control with the left on a Mac, asks for the context menu.
        onPointerDown={(event) => {
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
