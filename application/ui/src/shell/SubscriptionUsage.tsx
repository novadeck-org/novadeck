import {
  Accessibility,
  AutoScroller,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { createElement, useEffect, useState, type ComponentProps } from "react"

import { resetText, type AgentAccount, type UsageWindow } from "../model/account-usage"
import { programIcon } from "../terminals/processes/profiles"
import { ContextMenu, type ContextMenuItem } from "../ui-toolkit/ContextMenu"
import { Popover } from "../ui-toolkit/Popover"

const percent = (fraction: number): string => `${Math.round(fraction * 100)}%`

// The agent's own icon, as its terminals' tabs show it.
const agentIcon = (program: string, size: number): React.JSX.Element =>
  createElement(programIcon(program), { size, strokeWidth: 1.5, "aria-hidden": true })

// How much of a window is used, as a bar.
const UsageBar = ({ used }: { used: number }): React.JSX.Element => (
  <span className="usage-bar" aria-hidden>
    <span style={{ width: `${Math.round(Math.min(1, used) * 100)}%` }} />
  </span>
)

// One window of a subscription in its detail: its name, its bar and share, and when it
// resets, where its agent says.
const WindowRow = ({ window, now }: { window: UsageWindow; now: number }): React.JSX.Element => (
  <div className="usage-row">
    <span className="usage-row-name">{window.name}</span>
    <UsageBar used={window.used} />
    <span className="usage-row-share">{percent(window.used)}</span>
    {window.resetsAt !== null && (
      <span className="usage-row-reset">resets {resetText(window.resetsAt, now)}</span>
    )}
  </div>
)

// A subscription in full, each window with when it resets, kept current while open.
const UsageDetail = ({ account }: { account: AgentAccount }): React.JSX.Element => {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return (
    <div className="usage-detail">
      <h2 className="usage-agent-name">
        {agentIcon(account.program, 13)}
        {account.name}
      </h2>
      {account.windows.map((window) => (
        <WindowRow key={window.key} window={window} now={now} />
      ))}
    </div>
  )
}

// One agent's subscription as a pill: its icon, its most used window as a bar and share.
// Pressed, it opens that subscription in full, above it.
const SubscriptionPill = ({
  account,
  movable,
}: {
  account: AgentAccount
  // Whether there are others to move it among.
  movable: boolean
}): React.JSX.Element => {
  const [open, setOpen] = useState(false)
  const { busiest } = account
  return (
    <Popover
      label={`${account.name} subscription`}
      open={open}
      onOpenChange={setOpen}
      placement="top-end"
      className="usage-popover"
      trigger={
        <button
          type="button"
          className="footer-usage-pill"
          aria-label={`${account.name} subscription: ${busiest.name} ${percent(busiest.used)} used`}
          aria-description={
            movable ? "Drag to reorder, or use Move left and Move right in its menu." : undefined
          }
        >
          {agentIcon(account.program, 12)}
          <UsageBar used={busiest.used} />
          <span aria-hidden>
            {busiest.name} {percent(busiest.used)}
          </span>
        </button>
      }
    >
      <UsageDetail account={account} />
    </Popover>
  )
}

// Dragging the pills: from 6px of movement with a mouse, a quarter second's press on
// touch, so a click still opens one; as the taskbar's icons are dragged, without its
// accessibility plugin, which would write onto the pill's own state, and with the menu as
// the keyboard's way.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
const plugins: ComponentProps<typeof DragDropProvider>["plugins"] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== AutoScroller && plugin !== Accessibility),
  Feedback.configure({ dropAnimation: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" } }),
]

// A pill where the person can move it: dragged by its button, or from its menu.
const SortablePill = ({
  account,
  index,
  count,
  onMove,
}: {
  account: AgentAccount
  index: number
  count: number
  onMove: (from: number, to: number) => void
}): React.JSX.Element => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null)
  const handle = element?.querySelector<HTMLElement>(".footer-usage-pill") ?? undefined
  const { isDragSource } = useSortable({
    id: account.program,
    index,
    element: element ?? undefined,
    handle,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
  })
  const menu: ContextMenuItem[] = [
    ...(index > 0
      ? [{ value: "move-left", label: "Move left", onSelect: () => onMove(index, index - 1) }]
      : []),
    ...(index < count - 1
      ? [{ value: "move-right", label: "Move right", onSelect: () => onMove(index, index + 1) }]
      : []),
  ]
  const pill = (
    <span className="footer-usage-slot">
      <SubscriptionPill account={account} movable={count > 1} />
    </span>
  )
  return (
    <span
      ref={setElement}
      className="footer-usage-sortable"
      data-dragging={isDragSource || undefined}
    >
      {menu.length > 0 ? (
        <ContextMenu label={`${account.name} subscription actions`} items={menu} trigger={pill} />
      ) : (
        pill
      )}
    </span>
  )
}

// The account's subscriptions at the footer's end, a pill for each agent's, in the order
// the person left them, each opening its own; dragged or moved from its menu, a pill moves
// among them. Nothing shows while no agent reports its limits.
export const SubscriptionUsage = ({
  accounts,
  onMove,
}: {
  accounts: readonly AgentAccount[]
  onMove: (from: number, to: number) => void
}): React.JSX.Element | null =>
  accounts.length === 0 ? null : (
    <span className="footer-usage" role="group" aria-label="Subscriptions">
      <DragDropProvider
        sensors={sensors}
        plugins={plugins}
        onDragEnd={(event) => {
          const { source } = event.operation
          if (!event.canceled && isSortable(source) && source.initialIndex !== source.index)
            onMove(source.initialIndex, source.index)
        }}
      >
        {accounts.map((account, index) => (
          <SortablePill
            key={account.program}
            account={account}
            index={index}
            count={accounts.length}
            onMove={onMove}
          />
        ))}
      </DragDropProvider>
    </span>
  )
