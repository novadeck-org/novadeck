import { Popover as ArkPopover, usePopoverContext } from "@ark-ui/react/popover"
import { Portal } from "@ark-ui/react/portal"
import { useLayoutEffect, useMemo, useRef, type ReactNode } from "react"

export type SheetProps = {
  readonly label: string
  readonly open: boolean
  // Where its anchor is now, read each time the sheet places itself.
  readonly anchor: () => HTMLElement | null
  // What it stays within: the area it slides along to fit.
  readonly boundary: () => HTMLElement | null
  // What the anchor is: the sheet starts over, and places itself anew, when it changes.
  readonly anchorKey: string
  // Where the anchor stands among what is around it: the sheet moves to it, as it is, when
  // that changes, as when its row moves in a list.
  readonly placeKey?: string
  // A click or focus outside the sheet; `preventDefault()` keeps it open.
  readonly onInteractOutside: (event: {
    readonly target: EventTarget | null
    readonly preventDefault: () => void
  }) => void
  // The sheet asks to close, as a click outside it does.
  readonly onDismiss: () => void
  readonly children: ReactNode
  readonly className?: string
}

// A card that opens beside an element of the page and points at it with an arrow, as a
// popover does, but with no trigger of its own: the page says what it is anchored to. It
// is not modal and takes no focus; its owner closes it (Esc and its close button are the
// owner's), or a click outside does, unless the owner vetoes that.
export const Sheet = ({
  label,
  open,
  anchor,
  boundary,
  anchorKey,
  placeKey,
  onInteractOutside,
  onDismiss,
  children,
  className,
}: SheetProps): React.JSX.Element => {
  // What the placement reads, as of the last commit: it reads them again at every
  // placement, as the page scrolls or resizes.
  const reads = useRef({ anchor, boundary })
  useLayoutEffect(() => {
    reads.current = { anchor, boundary }
  })
  const last = useRef<DOMRect | null>(null)
  const positioning = useMemo(
    () => ({
      placement: "right-start" as const,
      strategy: "fixed" as const,
      // 8 px from the anchor, so a sheet beside a sidebar's row starts over its gutter.
      gutter: 8,
      offset: { mainAxis: 8, crossAxis: -12 },
      overflowPadding: 12,
      flip: false,
      fitViewport: true,
      boundary: () => reads.current.boundary() ?? document.body,
      // Where the anchor last was, where it has gone: the sheet stays put.
      getAnchorRect: () => {
        const rect = reads.current.anchor()?.getBoundingClientRect()
        if (rect) last.current = rect
        return last.current
      },
    }),
    [],
  )
  return (
    <ArkPopover.Root
      // A sheet placed for one anchor is placed again, from nothing, for the next.
      key={anchorKey}
      open={open}
      onOpenChange={({ open: next }) => {
        if (!next) onDismiss()
      }}
      modal={false}
      autoFocus={false}
      restoreFocus={false}
      closeOnEscape={false}
      onInteractOutside={(event) =>
        onInteractOutside({
          target: event.detail.target ?? null,
          preventDefault: () => event.preventDefault(),
        })
      }
      positioning={positioning}
      lazyMount
      unmountOnExit
    >
      <Replaced placeKey={placeKey} />
      <ArkPopover.Anchor asChild>
        <span className="absolute size-0" aria-hidden="true" />
      </ArkPopover.Anchor>
      <Portal>
        <ArkPopover.Positioner className="z-40">
          <ArkPopover.Content aria-label={label} className={`sheet ${className ?? ""}`}>
            <ArkPopover.Arrow className="sheet-arrow">
              <ArkPopover.ArrowTip />
            </ArkPopover.Arrow>
            {children}
          </ArkPopover.Content>
        </ArkPopover.Positioner>
      </Portal>
    </ArkPopover.Root>
  )
}

// Places the sheet again when its anchor has moved, after the move is on the page.
const Replaced = ({ placeKey }: { placeKey: string | undefined }): null => {
  const { reposition } = usePopoverContext()
  const placed = useRef(placeKey)
  useLayoutEffect(() => {
    if (placed.current === placeKey) return
    placed.current = placeKey
    reposition()
  }, [placeKey, reposition])
  return null
}
