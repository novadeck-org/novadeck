import { Menu as ArkMenu } from "@ark-ui/react/menu"
import { Portal } from "@ark-ui/react/portal"
import { ChevronRight } from "lucide-react"
import { useId, useRef, useState, type ReactElement, type ReactNode } from "react"

export type ContextMenuAction = {
  value: string
  label: string
  icon?: ReactNode
  // Shown but not chosen, for an action that can't happen now.
  disabled?: boolean
  // Runs once the menu has closed and focus has settled, so an item that moves focus,
  // as into a field, keeps it.
  onSelect: () => void
}

// An entry that opens a menu of its own beside it, as a list to pick one from.
export type ContextMenuSubmenu = {
  value: string
  label: string
  icon?: ReactNode
  items: ContextMenuAction[]
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSubmenu

const itemClasses =
  "item flex min-h-8 cursor-pointer items-center gap-2 px-2 py-1.5 data-disabled:cursor-default"
const contentClasses = "floating min-w-40 p-1 text-control"

// The menu's entries. Choosing an action keeps it to run once the whole menu has closed:
// `choose` for one here, `chooseNested` for one in a submenu, which closes only itself.
const MenuEntries = ({
  items,
  choose,
  chooseNested,
}: {
  items: readonly ContextMenuItem[]
  choose: (run: () => void) => void
  chooseNested: (run: () => void) => void
}): React.JSX.Element => (
  <>
    {items.map((item) =>
      "items" in item ? (
        <ArkMenu.Root
          key={item.value}
          positioning={{ placement: "right-start", gutter: 2, overflowPadding: 12 }}
          lazyMount
          unmountOnExit
        >
          <ArkMenu.TriggerItem className={itemClasses}>
            {item.icon}
            <span className="flex-1">{item.label}</span>
            <ChevronRight size={13} strokeWidth={1.5} aria-hidden />
          </ArkMenu.TriggerItem>
          <Portal>
            <ArkMenu.Positioner className="context-menu-positioner z-50!">
              <ArkMenu.Content className={contentClasses}>
                <MenuEntries items={item.items} choose={chooseNested} chooseNested={chooseNested} />
              </ArkMenu.Content>
            </ArkMenu.Positioner>
          </Portal>
        </ArkMenu.Root>
      ) : (
        <ArkMenu.Item
          key={item.value}
          value={item.value}
          disabled={item.disabled}
          onSelect={() => choose(item.onSelect)}
          className={itemClasses}
        >
          {item.icon}
          <ArkMenu.ItemText>{item.label}</ArkMenu.ItemText>
        </ArkMenu.Item>
      ),
    )}
  </>
)

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
  // Open as Ark says, and closed here too when a submenu's item is chosen, as Ark closes
  // only that submenu.
  const [open, setOpen] = useState(false)
  // Once the menu has closed, focus goes back where it was and what was chosen runs. The
  // closing menu keeps focus for a frame or two before letting it go.
  const closed = (): void => {
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
  }
  return (
    <ArkMenu.Root
      open={open}
      positioning={{ strategy: "fixed", overflowPadding: 12 }}
      immediate
      onOpenChange={({ open: next }) => {
        setOpen(next)
        if (!next) closed()
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
          <ArkMenu.Content aria-labelledby={labelId} className={contentClasses}>
            <span id={labelId} className="sr-only">
              {label}
            </span>
            <MenuEntries
              items={items}
              choose={(run) => {
                chosen.current = run
              }}
              chooseNested={(run) => {
                chosen.current = run
                setOpen(false)
                closed()
              }}
            />
          </ArkMenu.Content>
        </ArkMenu.Positioner>
      </Portal>
    </ArkMenu.Root>
  )
}
