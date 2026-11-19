import { Menu as ArkMenu } from "@ark-ui/react/menu"
import { Portal } from "@ark-ui/react/portal"
import { ChevronRight } from "lucide-react"
import {
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type RefObject,
} from "react"

import { Tooltip } from "./Tooltip"

export type ContextMenuAction = {
  readonly value: string
  readonly label: string
  readonly icon?: ReactNode
  // Shown but not chosen, for an action that can't happen now.
  readonly disabled?: boolean
  // What it says at its end, muted, as a count.
  readonly detail?: ReactNode
  // A hairline above it, setting it apart from the items before.
  readonly separated?: boolean
  // Runs once the menu has closed and focus has settled, so an item that moves focus,
  // as into a field, keeps it.
  readonly onSelect: () => void
}

// An entry that opens a menu of its own beside it, as a list to pick one from.
export type ContextMenuSubmenu = {
  readonly value: string
  readonly label: string
  readonly icon?: ReactNode
  readonly items: readonly ContextMenuAction[]
}

export type ContextMenuItem = ContextMenuAction | ContextMenuSubmenu

const itemClasses =
  "item flex min-h-8 cursor-pointer items-center gap-2 px-2 py-1.5 data-disabled:cursor-default"
const contentClasses = "floating min-w-40 p-1 text-control"

// The menu's entries. Choosing an action keeps it to run once the whole menu has closed:
// `choose` for one here, `chooseNested` for one in a submenu, which closes only itself.
const MenuEntries = ({
  items,
  open,
  choose,
  chooseNested,
}: {
  readonly items: readonly ContextMenuItem[]
  // Whether the menu is open: a submenu's own menu runs only then. Mounted with a closed one,
  // or through its closing, it would stand by on its trigger and hold up a drag that starts
  // there as the menu closes; its row is drawn alone till then.
  readonly open: boolean
  readonly choose: (run: () => void) => void
  readonly chooseNested: (run: () => void) => void
}): React.JSX.Element => (
  <>
    {items.map((item) =>
      "items" in item && !open ? (
        <div key={item.value} className={itemClasses} aria-hidden="true">
          {item.icon}
          <span className="flex-1">{item.label}</span>
          <ChevronRight size={12} strokeWidth={1.5} aria-hidden />
        </div>
      ) : "items" in item ? (
        <ArkMenu.Root
          key={item.value}
          positioning={{ placement: "right-start", gutter: 2, overflowPadding: 12 }}
          lazyMount
          unmountOnExit
        >
          <ArkMenu.TriggerItem className={itemClasses}>
            {item.icon}
            <span className="flex-1">{item.label}</span>
            <ChevronRight size={12} strokeWidth={1.5} aria-hidden />
          </ArkMenu.TriggerItem>
          <Portal>
            <ArkMenu.Positioner className="z-50!">
              <ArkMenu.Content className={contentClasses}>
                <MenuEntries
                  items={item.items}
                  open
                  choose={chooseNested}
                  chooseNested={chooseNested}
                />
              </ArkMenu.Content>
            </ArkMenu.Positioner>
          </Portal>
        </ArkMenu.Root>
      ) : (
        <Fragment key={item.value}>
          {item.separated && <ArkMenu.Separator className="separator mx-1.5 my-1 h-px" />}
          <ArkMenu.Item
            value={item.value}
            disabled={item.disabled}
            onSelect={() => choose(item.onSelect)}
            className={itemClasses}
          >
            {item.icon}
            <ArkMenu.ItemText className={item.detail === undefined ? undefined : "flex-1"}>
              {item.label}
            </ArkMenu.ItemText>
            {item.detail !== undefined && (
              <span className="item-detail flex shrink-0 items-center gap-1.5 pl-3">
                {item.detail}
              </span>
            )}
          </ArkMenu.Item>
        </Fragment>
      ),
    )}
  </>
)

const restore = (
  opener: RefObject<HTMLElement | null>,
  chosen: RefObject<(() => void) | undefined>,
  frames: number,
): void => {
  requestAnimationFrame(() => {
    const active = document.activeElement
    if (!active || active === document.body) {
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true })
    } else if (frames > 0 && active.closest('[data-scope="menu"]')) {
      restore(opener, chosen, frames - 1)
      return
    }
    const run = chosen.current
    chosen.current = undefined
    run?.()
  })
}

// A point in the window, in CSS pixels from its top left, as a pointer event's client point.
export type MenuPoint = { readonly x: number; readonly y: number }

type MenuCommon = {
  readonly label: string
  readonly items: readonly ContextMenuItem[]
  // Told when the menu opens and when it has closed.
  readonly onOpenChange?: (open: boolean) => void
}

/**
 * A menu of actions: on its trigger, opened by a right-click or a click; or, with `at` and no
 * trigger, open at that point while it's set, for what asks for a menu where no element of
 * the app's page can hear it, as a right-click in a live page's own view. Closed by the
 * person, it says so through `onOpenChange`, for its caller to unset `at`; a new `at` opens
 * it afresh there.
 */
export type ContextMenuProps = MenuCommon &
  (
    | (TriggeredProps & { readonly at?: undefined })
    | { readonly at: MenuPoint | undefined; readonly trigger?: undefined }
  )

type TriggeredProps = {
  readonly trigger: ReactElement
  // What asks for the menu: a right-click on the trigger (`context`, the default), or a plain
  // click on the trigger (`click`), which opens it above, ending where the trigger does, and
  // gives focus back to the trigger.
  readonly opensOn?: "context" | "click"
  // Where a `click` menu opens from its trigger: above (the default), or below it, for a trigger
  // at the top of a window.
  readonly placement?: "top-end" | "bottom-end"
  // What the trigger's tooltip says while the menu is closed, for a `click` trigger. The trigger's
  // Ark data attributes are then the tooltip's: style its open state by aria-expanded.
  readonly tooltip?: string
}

export const ContextMenu = (props: ContextMenuProps): React.JSX.Element =>
  props.trigger === undefined ? (
    // Its own for each point, so a new one opens it afresh there.
    <MenuAt key={props.at && `${props.at.x},${props.at.y}`} {...props} />
  ) : (
    <TriggeredMenu {...props} />
  )

// The menu at a point while one is set, focus going back where it was once it closes.
const MenuAt = ({
  label,
  items,
  at,
  onOpenChange,
}: MenuCommon & { readonly at: MenuPoint | undefined }): React.JSX.Element => {
  const labelId = useId()
  // Mounted afresh for each point (see `ContextMenu`), focus as it was when asked for. It
  // opens a frame after it mounts: Ark places a menu at its point only as it opens.
  const opener = useRef<HTMLElement | null>(
    at && document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  const chosen = useRef<(() => void) | undefined>(undefined)
  const [open, setOpen] = useState(false)
  const asked = at !== undefined
  useEffect(() => {
    if (!asked) return
    const frame = requestAnimationFrame(() => setOpen(true))
    return () => cancelAnimationFrame(frame)
  }, [asked])
  const closed = (): void => restore(opener, chosen, 3)
  return (
    <ArkMenu.Root
      open={open && at !== undefined}
      anchorPoint={at ?? null}
      positioning={{ strategy: "fixed", overflowPadding: 12 }}
      onOpenChange={({ open: next }) => {
        setOpen(next)
        onOpenChange?.(next)
        if (!next) closed()
      }}
    >
      {/* What Ark places a menu by, as it has none to open from: nothing to see or reach,
          at the point, in the page's body, where nothing around it moves what's fixed. */}
      {at && (
        <Portal>
          <ArkMenu.Trigger asChild>
            <span
              aria-hidden="true"
              style={{ position: "fixed", left: at.x, top: at.y, width: 0, height: 0 }}
            />
          </ArkMenu.Trigger>
        </Portal>
      )}
      <MenuBody
        labelId={labelId}
        label={label}
        items={items}
        open={open}
        choose={(run) => {
          chosen.current = run
        }}
        chooseNested={(run) => {
          chosen.current = run
          setOpen(false)
          onOpenChange?.(false)
          closed()
        }}
      />
    </ArkMenu.Root>
  )
}

// The open menu's body: its label for a screen reader, and its entries.
const MenuBody = ({
  labelId,
  label,
  items,
  open,
  choose,
  chooseNested,
}: {
  readonly labelId: string
  readonly label: string
  readonly items: readonly ContextMenuItem[]
  readonly open: boolean
  readonly choose: (run: () => void) => void
  readonly chooseNested: (run: () => void) => void
}): React.JSX.Element => (
  <Portal>
    <ArkMenu.Positioner className="z-50!">
      <ArkMenu.Content aria-labelledby={labelId} className={contentClasses}>
        <span id={labelId} className="sr-only">
          {label}
        </span>
        <MenuEntries items={items} open={open} choose={choose} chooseNested={chooseNested} />
      </ArkMenu.Content>
    </ArkMenu.Positioner>
  </Portal>
)

const TriggeredMenu = ({
  label,
  trigger,
  items,
  opensOn = "context",
  placement = "top-end",
  tooltip,
  onOpenChange,
}: MenuCommon & TriggeredProps): React.JSX.Element => {
  const labelId = useId()
  // One id for the trigger, which a tooltip around it shares.
  const triggerId = useId()
  const clicked = opensOn === "click"
  const button = useRef<HTMLButtonElement | null>(null)
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
  const closed = (): void => restore(opener, chosen, 3)
  return (
    <ArkMenu.Root
      open={open}
      ids={{ trigger: triggerId }}
      positioning={{
        strategy: "fixed",
        overflowPadding: 12,
        ...(clicked ? { placement, gutter: 6 } : {}),
      }}
      immediate
      onOpenChange={({ open: next }) => {
        setOpen(next)
        onOpenChange?.(next)
        if (next && clicked) opener.current = button.current
        if (!next) closed()
      }}
    >
      {clicked ? (
        tooltip ? (
          <Tooltip content={tooltip} disabled={open}>
            <ArkMenu.Trigger asChild ref={button} id={triggerId}>
              {trigger}
            </ArkMenu.Trigger>
          </Tooltip>
        ) : (
          <ArkMenu.Trigger asChild ref={button}>
            {trigger}
          </ArkMenu.Trigger>
        )
      ) : (
        <ArkMenu.ContextTrigger
          asChild
          onContextMenu={() => {
            opener.current =
              document.activeElement instanceof HTMLElement ? document.activeElement : null
          }}
        >
          {trigger}
        </ArkMenu.ContextTrigger>
      )}
      <MenuBody
        labelId={labelId}
        label={label}
        items={items}
        open={open}
        choose={(run) => {
          chosen.current = run
        }}
        chooseNested={(run) => {
          chosen.current = run
          setOpen(false)
          closed()
        }}
      />
    </ArkMenu.Root>
  )
}
