import {
  Accessibility,
  AutoScroller,
  Cursor,
  Feedback,
  PointerActivationConstraints,
  PointerSensor,
} from "@dnd-kit/dom"
import type { DragDropProvider } from "@dnd-kit/react"
import { isSortable } from "@dnd-kit/react/sortable"
import type { LucideIcon } from "lucide-react"
import { useRef, useState, type ComponentProps, type RefObject } from "react"

import { useDragSession, type BarDrag } from "../drag-session"
import type { BarMember, BarSlot } from "./bar"
import { titleOf } from "./plan-text"
import { beyond, refuseDrop } from "./tether"

// Dragging a taskbar's icons: within the bar, which reorders it, and off it, onto another
// terminal's bar or a view's free space, through the app's drag session. A card pulled out
// of a peek turns into an icon of its own and goes the same ways. The messages stay on
// their bar: dragged off, the pointer says they can't go.

// From 6px of movement with a mouse, a quarter second's press on touch, so a click still
// opens and a press still peeks.
const sensors = [
  PointerSensor.configure({
    activationConstraints: (event) =>
      event.pointerType === "touch"
        ? [new PointerActivationConstraints.Delay({ value: 250, tolerance: 5 })]
        : [new PointerActivationConstraints.Distance({ value: 6 })],
  }),
]
const feedback = Feedback.configure({
  dropAnimation: { duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
})
const cursor = Cursor.configure({ cursor: "grabbing" })
// No scrolling the view under a dragged icon: where it would drop must stay where its
// outline shows. No accessibility plugin either: it writes `aria-pressed` onto every
// handle, and an icon's says whether the pane shows it. The icon describes its drag
// itself (TaskbarSlot.tsx), and the keyboard's way is its menu, not a drag.
const plugins: ComponentProps<typeof DragDropProvider>["plugins"] = (defaults) => [
  ...defaults.filter((plugin) => plugin !== AutoScroller && plugin !== Accessibility),
  feedback,
  cursor,
]

// What leaves the bar when a drag does: a slot, or one card of a stack's peek.
export type Dragged = {
  readonly members: readonly BarMember[]
  // What its window would be called; whether a drop on free space undocks it.
  readonly name: string
  readonly undocks: boolean
}

// What a drag carries off the bar: its window's name, and whether a drop on free space
// opens it in one, as one plan or one thing this terminal's agent showed does.
const draggedOf = (members: readonly BarMember[]): Dragged => {
  const [only] = members
  const content = members.length === 1 ? only?.content : undefined
  return {
    members,
    name:
      content?.kind === "plan"
        ? titleOf(content.plan.path, content.plan.text)
        : content?.kind === "artifact"
          ? content.artifact.name
          : "",
    undocks: Boolean(only && content && content.kind !== "messages" && !only.placed),
  }
}

// A card pulled out of a peek, as the icon it turned into, and the icon it came from,
// which it settles back into when it lands nowhere.
type Grabbed = { readonly icon: LucideIcon; readonly from: DOMRect | undefined }

// What the taskbar renders from its drags: the drag provider's handlers, the press that
// pulls a card out of a peek, and the icon that card turned into, which follows the
// pointer by the element `grabbedIconRef` receives.
export type BarDragging = {
  readonly provider: Pick<
    ComponentProps<typeof DragDropProvider>,
    "sensors" | "plugins" | "onDragStart" | "onDragEnd"
  >
  readonly grab: (
    event: React.PointerEvent<HTMLElement>,
    member: BarMember,
    icon: LucideIcon,
    slot: string,
  ) => void
  readonly grabbed: LucideIcon | null
  readonly grabbedIconRef: (element: HTMLDivElement | null) => void
}

const tethered = (members: readonly BarMember[]): boolean =>
  members.some((member) => member.content.kind === "messages")

export const useBarDrag = ({
  terminal,
  slots,
  bar,
  move,
  land,
}: {
  // This bar's terminal, and its icons.
  terminal: string
  slots: readonly BarSlot[]
  bar: RefObject<HTMLElement | null>
  move: (from: number, to: number) => void
  // Whether what was dragged landed where the drag ended.
  land: (dragged: Dragged, ended: BarDrag) => boolean
}): BarDragging => {
  const session = useDragSession()
  // Ends following the pointer once a drag ends.
  const stopFollowing = useRef<(() => void) | undefined>(undefined)
  const [grabbed, setGrabbedNow] = useState<Grabbed | null>(null)
  const grabbedRef = useRef<Grabbed | null>(null)
  const setGrabbed = (next: Grabbed | null): void => {
    grabbedRef.current = next
    setGrabbedNow(next)
  }
  const grabbedIcon = useRef<HTMLDivElement | null>(null)
  const grabbedAt = useRef({ x: 0, y: 0 })

  const begin = (members: readonly BarMember[]): void => {
    if (!tethered(members)) session.start({ from: terminal, ...draggedOf(members) })
  }
  const follow = (members: readonly BarMember[], x: number, y: number): void => {
    if (!tethered(members)) return session.move(x, y)
    const own = bar.current?.getBoundingClientRect()
    refuseDrop(Boolean(own && beyond(x, y, own)))
  }
  const finish = (members: readonly BarMember[] | undefined, cancelled: boolean): boolean => {
    refuseDrop(false)
    const ended = session.end(cancelled || !members)
    return Boolean(members && ended && land(draggedOf(members), ended))
  }

  const slotOf = (id: unknown): BarSlot | undefined => slots.find((slot) => slot.key === String(id))
  const provider: BarDragging["provider"] = {
    sensors,
    plugins,
    onDragStart: (event) => {
      const members = slotOf(event.operation.source?.id)?.members ?? []
      begin(members)
      // The drag keeps the pointer's moves to itself, so this listens ahead of it.
      const moved = (pointer: PointerEvent): void =>
        follow(members, pointer.clientX, pointer.clientY)
      window.addEventListener("pointermove", moved, { capture: true })
      stopFollowing.current = () =>
        window.removeEventListener("pointermove", moved, { capture: true })
    },
    onDragEnd: (event) => {
      stopFollowing.current?.()
      stopFollowing.current = undefined
      const { source } = event.operation
      const sortable = !event.canceled && isSortable(source)
      // Where the bar's own drag left it, so the bar stays as its DOM shows it.
      if (sortable && source.initialIndex !== source.index) move(source.initialIndex, source.index)
      finish(sortable ? slotOf(source.id)?.members : undefined, event.canceled)
    },
  }

  // The grabbed icon goes: at once where it landed, which shows it there; back into the
  // icon it came from where it didn't.
  const settle = (landed: boolean): void => {
    const icon = grabbedIcon.current
    const to = grabbedRef.current?.from
    if (landed || !icon || !to || matchMedia("(prefers-reduced-motion: reduce)").matches)
      return setGrabbed(null)
    icon.dataset.settling = ""
    icon.style.setProperty("translate", `${to.left + to.width / 2}px ${to.top + to.height / 2}px`)
    setTimeout(() => setGrabbed(null), 180)
  }

  // A card pressed in a peek: past the same thresholds as an icon, it turns into an icon
  // of its own, `member` alone, and goes wherever a dragged icon would.
  const grab = (
    start: React.PointerEvent<HTMLElement>,
    member: BarMember,
    icon: LucideIcon,
    slot: string,
  ): void => {
    if (start.button !== 0 || start.ctrlKey) return
    const touch = start.pointerType === "touch"
    const from = { x: start.clientX, y: start.clientY }
    const home = bar.current?.querySelector(`[data-slot="${CSS.escape(slot)}"] .plan-tb-item`)
    let armed = !touch
    let dragging = false
    const press = touch ? setTimeout(() => (armed = true), 250) : undefined
    const members = [member]
    const moved = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== start.pointerId) return
      const distance = Math.hypot(pointer.clientX - from.x, pointer.clientY - from.y)
      if (!dragging) {
        if (touch && !armed && distance > 5) return stop()
        if (!armed || (!touch && distance < 6)) return
        dragging = true
        grabbedAt.current = { x: pointer.clientX, y: pointer.clientY }
        setGrabbed({ icon, from: home?.getBoundingClientRect() })
        begin(members)
      }
      pointer.preventDefault()
      grabbedIcon.current?.style.setProperty(
        "translate",
        `${pointer.clientX}px ${pointer.clientY}px`,
      )
      follow(members, pointer.clientX, pointer.clientY)
    }
    const released = (pointer: PointerEvent): void => {
      if (pointer.pointerId !== start.pointerId) return
      stop()
      if (dragging) settle(finish(members, false))
    }
    const cancelled = (key: KeyboardEvent): void => {
      if (key.key !== "Escape" || !dragging) return
      key.stopPropagation()
      stop()
      finish(members, true)
      settle(false)
    }
    const stop = (): void => {
      clearTimeout(press)
      window.removeEventListener("pointermove", moved, { capture: true })
      window.removeEventListener("pointerup", released, { capture: true })
      window.removeEventListener("pointercancel", released, { capture: true })
      window.removeEventListener("keydown", cancelled, { capture: true })
    }
    window.addEventListener("pointermove", moved, { capture: true })
    window.addEventListener("pointerup", released, { capture: true })
    window.addEventListener("pointercancel", released, { capture: true })
    window.addEventListener("keydown", cancelled, { capture: true })
  }

  // The card pulled out, following the pointer by its style rather than by rendering.
  const grabbedIconRef = (element: HTMLDivElement | null): void => {
    grabbedIcon.current = element
    // Placed once here; from then on it follows the pointer by its style.
    if (element && !element.style.translate)
      element.style.translate = `${grabbedAt.current.x}px ${grabbedAt.current.y}px`
  }

  return { provider, grab, grabbed: grabbed?.icon ?? null, grabbedIconRef }
}
