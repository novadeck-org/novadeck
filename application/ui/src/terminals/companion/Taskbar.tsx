import { DragDropProvider } from "@dnd-kit/react"
import { useSortable } from "@dnd-kit/react/sortable"
import { useRef, useState, type ReactNode } from "react"

import { Portal } from "../../ui-toolkit/Portal"
import type { Presence } from "../../ui-toolkit/presence"
import type { BarDrag } from "../drag-session"
import type { BarSlot } from "./bar"
import { TaskbarSlot, type SlotActions } from "./TaskbarSlot"
import { tether } from "./tether"
import { useBarDrag, type Dragged } from "./use-bar-drag"

// The messages' drag stays on their terminal's bar.
const onBar = [tether((operation) => operation.source?.element?.closest("[data-taskbar]") ?? null)]

// One slot as the bar's drag reorders it: its own box, a direct child of the bar, so the
// drag moves the whole slot. Its icon button is the handle, which carries what dnd-kit
// tells assistive technology, so no second button wraps the first.
const SortableSlot = ({
  id,
  index,
  tethered,
  children,
}: {
  id: string
  index: number
  // Held to its terminal's bar, as the messages are.
  tethered: boolean
  children: ReactNode
}): React.JSX.Element => {
  const [element, setElement] = useState<HTMLSpanElement | null>(null)
  const handle = element?.querySelector<HTMLElement>(".plan-tb-item") ?? undefined
  const { isDragSource } = useSortable({
    id,
    index,
    element: element ?? undefined,
    handle,
    transition: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    modifiers: tethered ? onBar : [],
  })
  return (
    <span
      className="plan-tb-sortable"
      ref={setElement}
      data-slot={id}
      data-dragging={isDragSource || undefined}
    >
      {children}
    </span>
  )
}

// A terminal's taskbar along its bottom: an icon for each of its plans, what its agent
// showed and its messages, and for what other terminals placed here, stacked by kind, in
// the order they came or the person dragged them into. Hover peeks, click opens or hides
// the pane, the menu does the rest. Nothing opens on its own.
export const Taskbar = ({
  terminal,
  agent,
  slots,
  actions,
  land,
  trigger,
  open,
  onHide,
  presence,
  dropTarget,
}: {
  terminal: string
  // Who showed what's here, as the bar's label names them.
  agent: string
  slots: readonly BarSlot[]
  actions: Omit<SlotActions, "grab">
  land: (dragged: Dragged, ended: BarDrag) => boolean
  trigger: React.RefObject<HTMLButtonElement | null>
  open: boolean
  onHide: () => void
  // How the bar comes and goes with what the terminal has to show.
  presence: Presence
  // An icon from another terminal's bar is over this one: a drop lands here.
  dropTarget: boolean
}): React.JSX.Element => {
  const bar = useRef<HTMLDivElement | null>(null)
  const { provider, grab, grabbed, grabbedIconRef } = useBarDrag({
    terminal,
    slots,
    bar,
    move: actions.move,
    land,
  })
  const Grabbed = grabbed
  return (
    <div
      {...presence.props}
      ref={(element) => {
        bar.current = element
        presence.props.ref(element)
      }}
      className="plan-taskbar nodrag nopan"
      data-taskbar=""
      data-drop-target={dropTarget || undefined}
      data-workspace-companion
      role="group"
      aria-label={`What ${agent} showed you`}
      // Opening leaves focus here, so Escape hides the pane from here too.
      onKeyDown={(event) => {
        // Keys from its menus and peeks bubble here through React's portals; theirs is
        // their own Escape.
        if (event.key !== "Escape" || !open) return
        if (!event.currentTarget.contains(event.target as Node)) return
        event.stopPropagation()
        onHide()
      }}
    >
      <DragDropProvider {...provider}>
        <span className="plan-tb-slots">
          {slots.map((slot, index) => (
            <SortableSlot
              key={slot.key}
              id={slot.key}
              index={index}
              tethered={slot.members.some((member) => member.kind === "messages")}
            >
              <TaskbarSlot
                slot={slot}
                index={index}
                count={slots.length}
                actions={{ ...actions, grab }}
                buttonRef={index === 0 ? trigger : undefined}
              />
            </SortableSlot>
          ))}
        </span>
      </DragDropProvider>
      {Grabbed && (
        <Portal>
          <div ref={grabbedIconRef} className="plan-tb-grabbed" aria-hidden="true">
            <span className="plan-tb-item" data-state="seen">
              <Grabbed size={20} strokeWidth={1.5} />
            </span>
          </div>
        </Portal>
      )}
    </div>
  )
}
