import {
  Accessibility,
  AutoScroller,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import { RestrictToElement } from "@dnd-kit/dom/modifiers"
import { DragDropProvider } from "@dnd-kit/react"
import { isSortable, useSortable } from "@dnd-kit/react/sortable"
import { sidebarPanels, type SidebarPanel } from "@novadeck/core/types"
import { ToggleGroup, ToggleGroupItem } from "@novadeck/toolkit/ToggleGroup"
import { FolderGit2, History, Inbox, Layers2, Terminal as TerminalIcon } from "lucide-react"
import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react"

import { shortcutBindings, type ShortcutName } from "../interaction/shortcuts"
import { BellDot } from "./BellDot"
import type { InboxBadge } from "./inbox-badge"
import { movedPanel } from "./rail-order"

const panels = {
  terminals: { label: "Terminals", icon: TerminalIcon },
  source: { label: "Source", icon: FolderGit2 },
  sessions: { label: "Sessions", icon: Layers2 },
  history: { label: "History", icon: History },
  inbox: { label: "Inbox", icon: Inbox },
} as const satisfies Record<SidebarPanel, { label: string; icon: unknown }>

// The panels with a key of their own.
const panelShortcuts: Partial<Record<SidebarPanel, ShortcutName>> = {
  terminals: "terminals",
  sessions: "sessions",
  inbox: "inbox",
}

// A toggle's tooltip: its panel, what it holds for the person, and, while its panel is open,
// where a click takes the sidebar: back to the base panel, or hidden on the base's own.
export const railTooltip = ({
  panel,
  detail,
  open,
  base,
}: {
  panel: SidebarPanel
  detail?: string | undefined
  open: boolean
  base: SidebarPanel | null
}): string => {
  const action = open
    ? base && base !== panel
      ? `back to ${panels[base].label}`
      : "hide sidebar"
    : undefined
  const shortcut = panelShortcuts[panel]
  // Its keys joined by no-break spaces, so a wrapping tooltip keeps them on one line.
  const keys = shortcut ? shortcutBindings()[shortcut].display.join("\u00a0") : undefined
  return [panels[panel].label, detail, action, keys].filter(Boolean).join(" · ")
}

// Dragging the toggles: from 6px of movement with a mouse, a quarter second's press on
// touch, so a click still opens a panel; along the rail only, without dnd-kit's
// accessibility plugin, which would write onto the toggle's own state, and with Alt and the
// arrows as the keyboard's way.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
const transition = { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
const plugins: ComponentProps<typeof DragDropProvider>["plugins"] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== AutoScroller && plugin !== Accessibility),
  Feedback.configure({ dropAnimation: transition }),
  Cursor.configure({ cursor: "grabbing" }),
]
// The rail the dragged toggle is on, of the two a phone's drawer can show.
const modifiers = [
  RestrictToElement.configure({
    element: (operation) => operation.source?.element?.closest(".sidebar-tools") ?? null,
  }),
]

// The rail's toggles for the sidebar's panels, in the order the person left them: dragged
// along the rail, or with Alt and the up and down arrows, a toggle moves among the others,
// and `onOrder` tells the new order, which is the caller's to keep.
export const SidebarRail = ({
  mobile = false,
  sidebarVisible,
  sidebarPanel,
  sidebarBase = null,
  zen,
  badge,
  bellRings,
  sessionsAsk,
  hasSource = false,
  hasHistory = false,
  order = sidebarPanels,
  onOrder,
  toggleSidebar,
}: {
  mobile?: boolean
  sidebarVisible: boolean
  sidebarPanel: SidebarPanel
  // The panel the sidebar was opened on, where the open panel's toggle goes back to.
  sidebarBase?: SidebarPanel | null
  zen: boolean
  badge: InboxBadge | undefined
  // How many new Inbox rows the bell has rung for, which its dot rings with.
  bellRings: number
  // What the sessions other than the open one ask of the person, in words, while any does: the
  // Sessions toggle's dot, name and tooltip.
  sessionsAsk?: string | undefined
  // Whether the backend has a Source panel to toggle.
  hasSource?: boolean
  // Whether the backend keeps closed terminals, which the History panel lists.
  hasHistory?: boolean
  // Every panel, the ones this backend doesn't show included, in the person's order.
  order?: readonly SidebarPanel[]
  onOrder?: (order: readonly SidebarPanel[]) => void
  toggleSidebar: (panel: SidebarPanel) => void
}): React.JSX.Element => {
  const shown = order.filter(
    (id) => (hasSource || id !== "source") && (hasHistory || id !== "history"),
  )
  const toggleId = (id: SidebarPanel): string => `${mobile ? "mobile-" : ""}${id}-toggle`
  const [dragging, setDragging] = useState(false)
  // The toggle that takes the focus after a keyboard move or a drag, as moving its button
  // among the others loses the focus it had; a new object asks again.
  const [focusRequest, setFocusRequest] = useState<{ id: SidebarPanel } | null>(null)
  // The same each render, so only a new request or a drop restarts the toggle's wait.
  const focused = useCallback(() => setFocusRequest(null), [])
  const move = (from: number, to: number): void => onOrder?.(movedPanel(order, shown, from, to))
  return (
    <DragDropProvider
      sensors={sensors}
      modifiers={modifiers}
      plugins={plugins}
      onDragStart={() => setDragging(true)}
      onDragEnd={(event) => {
        setDragging(false)
        const { source } = event.operation
        if (!isSortable(source)) return
        const id = shown.find((panel) => panel === source.id)
        if (id) setFocusRequest({ id })
        if (!event.canceled && source.initialIndex !== source.index)
          move(source.initialIndex, source.index)
      }}
    >
      <ToggleGroup
        className="sidebar-tools z-30 w-11 shrink-0 flex-col items-center gap-1 px-1.5 py-3"
        aria-label="Sidebar actions"
        aria-hidden={Boolean(zen)}
        orientation="vertical"
        value={sidebarVisible ? [sidebarPanel] : []}
        onValueChange={(value) => {
          // Pressing the open panel's toggle leaves none pressed: the command for that panel
          // decides whether it goes back to the base panel or hides the sidebar.
          toggleSidebar(sidebarPanels.find((panel) => panel === value[0]) ?? sidebarPanel)
        }}
      >
        {shown.map((id, index) => (
          <RailToggle
            key={id}
            id={toggleId(id)}
            value={id}
            index={index}
            count={shown.length}
            open={sidebarVisible && sidebarPanel === id}
            base={sidebarBase}
            badge={id === "inbox" ? badge : undefined}
            bellRings={bellRings}
            sessionsAsk={id === "sessions" ? sessionsAsk : undefined}
            dragging={dragging}
            focusRequest={focusRequest}
            onFocused={focused}
            onStep={(by) => {
              setFocusRequest({ id })
              move(index, index + by)
            }}
          />
        ))}
      </ToggleGroup>
    </DragDropProvider>
  )
}

// One panel's toggle, where the person can move it. The group finds its id and value on it.
const RailToggle = ({
  id,
  value,
  index,
  count,
  open,
  base,
  badge,
  bellRings,
  sessionsAsk,
  dragging,
  focusRequest,
  onFocused,
  onStep,
}: {
  id: string
  value: SidebarPanel
  index: number
  count: number
  // Its panel shows, so a click goes back to the base panel or hides the sidebar.
  open: boolean
  base: SidebarPanel | null
  // What the Inbox holds, on its toggle.
  badge: InboxBadge | undefined
  // How many new Inbox rows the bell has rung for, which its dot rings with.
  bellRings: number
  // What the other sessions ask of the person, on the Sessions toggle.
  sessionsAsk: string | undefined
  // Some toggle is being dragged, which leaves no tooltip open.
  dragging: boolean
  // Asks the toggle with this id to take the focus, once it has settled in its place.
  focusRequest: { id: SidebarPanel } | null
  // Told once the toggle has taken the focus it was asked for.
  onFocused: () => void
  onStep: (by: -1 | 1) => void
}): React.JSX.Element => {
  const { ref, isDragSource } = useSortable({ id: value, index, transition })
  const button = useRef<HTMLButtonElement | null>(null)
  // A dragged toggle has settled once its drop has played out. A dialog's focus trap, as
  // around a phone's drawer, sees the moved button leave and sends the focus to its first
  // control just after, so the toggle takes it again a frame later.
  useLayoutEffect(() => {
    if (focusRequest?.id !== value || isDragSource) return undefined
    const take = (): void => button.current?.focus({ preventScroll: true })
    take()
    const frame = requestAnimationFrame(() => {
      take()
      onFocused()
    })
    return () => cancelAnimationFrame(frame)
  }, [focusRequest, value, isDragSource, onFocused])
  const { label, icon: Icon } = panels[value]
  return (
    <ToggleGroupItem
      ref={(node) => {
        button.current = node
        ref(node)
      }}
      tooltip={railTooltip({
        panel: value,
        detail: badge ? `${badge.count} waiting` : sessionsAsk,
        open,
        base,
      })}
      tooltipDisabled={dragging}
      value={value}
      id={id}
      className="segment relative inline-flex size-8 shrink-0 items-center justify-center p-2 [&>svg]:shrink-0"
      aria-label={badge?.label ?? label}
      // The Sessions toggle keeps its name, so it is found by it; what the other sessions ask
      // is its description.
      aria-description={sessionsAsk}
      aria-keyshortcuts={[
        ...(index > 0 ? ["Alt+ArrowUp"] : []),
        ...(index < count - 1 ? ["Alt+ArrowDown"] : []),
      ].join(" ")}
      data-dragging={isDragSource ? "true" : undefined}
      // Before the group's own keys, which would move the focus along the rail instead.
      onKeyDownCapture={(event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
        if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return
        event.preventDefault()
        const by = event.key === "ArrowUp" ? -1 : 1
        if (index + by < 0 || index + by >= count) return
        onStep(by)
      }}
    >
      <Icon size={16} />
      {badge && <BellDot rings={bellRings} />}
      {sessionsAsk && <BellDot rings={0} />}
    </ToggleGroupItem>
  )
}
