import { Menu as ArkMenu } from "@ark-ui/react/menu"
import { Portal } from "@ark-ui/react/portal"
import { useId, useRef, type ReactElement, type ReactNode } from "react"

export type ContextMenuItem = {
  value: string
  label: string
  icon?: ReactNode
  // Runs once the menu has closed and focus has settled, so an item that moves focus,
  // as into a field, keeps it.
  onSelect: () => void
}

export type ContextMenuProps = {
  label: string
  trigger: ReactElement
  items: ContextMenuItem[]
}

export const ContextMenu = ({ label, trigger, items }: ContextMenuProps): React.JSX.Element => {
  const labelId = useId()
  // Where focus was when the menu was asked for. A context trigger often can't take
  // focus, so closing the menu would otherwise leave focus nowhere.
  const opener = useRef<HTMLElement | null>(null)
  // The item chosen, to run once the menu has closed.
  const chosen = useRef<(() => void) | undefined>(undefined)
  return (
    <ArkMenu.Root
      positioning={{ strategy: "fixed", overflowPadding: 12 }}
      immediate
      onOpenChange={({ open }) => {
        if (open) return
        // The closing menu keeps focus for a frame or two before letting it go.
        const restore = (frames: number): void => {
          requestAnimationFrame(() => {
            const active = document.activeElement
            if (!active || active === document.body) {
              if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
            } else if (frames > 0 && active.closest('[data-scope="menu"]')) {
              restore(frames - 1)
              return
            }
            const run = chosen.current
            chosen.current = undefined
            run?.()
          })
        }
        restore(3)
      }}
    >
      <ArkMenu.ContextTrigger
        asChild
        onContextMenu={() => {
          opener.current =
            document.activeElement instanceof HTMLElement ? document.activeElement : null
        }}
      >
        {trigger}
      </ArkMenu.ContextTrigger>
      <Portal>
        <ArkMenu.Positioner className="context-menu-positioner z-50!">
          <ArkMenu.Content
            aria-labelledby={labelId}
            className="min-w-40 rounded-popover border border-line bg-paper p-1 text-[11px] text-ink shadow-floating focus-visible:outline-none"
          >
            <span id={labelId} className="sr-only">
              {label}
            </span>
            {items.map((item) => (
              <ArkMenu.Item
                key={item.value}
                value={item.value}
                onSelect={() => {
                  chosen.current = item.onSelect
                }}
                className="flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2 py-1.5 outline-none data-highlighted:bg-shell"
              >
                {item.icon}
                <ArkMenu.ItemText>{item.label}</ArkMenu.ItemText>
              </ArkMenu.Item>
            ))}
          </ArkMenu.Content>
        </ArkMenu.Positioner>
      </Portal>
    </ArkMenu.Root>
  )
}
