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
import { FolderGit2, History, Inbox, Terminal as TerminalIcon } from "lucide-react"
import { useCallback, useLayoutEffect, useRef, useState, type ComponentProps } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import { BellCount } from "./BellCount"
import type { BellBadge } from "./inbox-badge"
import { movedPanel } from "./rail-order"

const panels = {
  terminals: { label: "Terminals", icon: TerminalIcon },
  source: { label: "Source", icon: FolderGit2 },
  sessions: { label: "Sessions", icon: History },
  inbox: { label: "Inbox", icon: Inbox },
} as const satisfies Record<SidebarPanel, { label: string; icon: unknown }>

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
  zen,
  badge,
  hasSource = false,
  order = sidebarPanels,
  onOrder,
  toggleSidebar,
  hideSidebar,
}: {
  mobile?: boolean
  sidebarVisible: boolean
  sidebarPanel: SidebarPanel
  zen: boolean
  badge: BellBadge | undefined
  // Whether the backend has a Source panel to toggle.
  hasSource?: boolean
  // Every panel, the ones this backend doesn't show included, in the person's order.
  order?: readonly SidebarPanel[]
  onOrder?: (order: readonly SidebarPanel[]) => void
  toggleSidebar: (panel: SidebarPanel) => void
  hideSidebar: () => void
}): React.JSX.Element => {
  const shown = order.filter((id) => hasSource || id !== "source")
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
          const next = sidebarPanels.find((panel) => panel === value[0])
          if (next) toggleSidebar(next)
          else hideSidebar()
        }}
      >
        {shown.map((id, index) => (
          <RailToggle
            key={id}
            id={toggleId(id)}
            value={id}
            index={index}
            count={shown.length}
            badge={id === "inbox" ? badge : undefined}
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
  badge,
  dragging,
  focusRequest,
  onFocused,
  onStep,
}: {
  id: string
  value: SidebarPanel
  index: number
  count: number
  // What the Inbox holds, on its toggle.
  badge: BellBadge | undefined
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
      tooltip={
        value === "terminals"
          ? `Terminals · ${shortcutBindings().terminals.display.join(" ")}`
          : label
      }
      tooltipDisabled={dragging}
      value={value}
      id={id}
      className="segment relative inline-flex size-8 shrink-0 items-center justify-center p-2 [&>svg]:shrink-0"
      aria-label={badge?.label ?? label}
      aria-keyshortcuts={[
        ...(index > 0 ? ["Alt+ArrowUp"] : []),
        ...(index < count - 1 ? ["Alt+ArrowDown"] : []),
      ].join(" ")}
      data-project-status={badge?.status}
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
      {badge && <BellCount text={badge.text} />}
    </ToggleGroupItem>
  )
}
