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
import { defaultPull, overflow, pull, PullOut } from "@novadeck/toolkit/drag-pull"
import type { LucideIcon } from "lucide-react"
import { useMemo, useRef, useState, type ComponentProps, type RefObject } from "react"

import { undocks, type BarMember, type BarSlot } from "./bar"
import { useDragSession, type BarDrag, type DragSession } from "./drag-session"
import { beyond, refuseDrop } from "./tether"

// Dragging a taskbar's icons: within the bar, which reorders it freely, and off it, onto
// another terminal's bar or a view's free space, through the app's drag session. An icon
// leaves the bar as anything pulled out of a list does (`PullOut`): past the bar's edge it
// resists, and only once pulled far enough does it break free, which is when the drag
// session first hears of it; let go before that, it only reorders. A card pulled out of a
// peek turns into an icon of its own and goes the same ways. The messages stay on their
// bar: dragged off, the pointer says they can't go.

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
// dnd-kit puts this on every element while a drag lasts, as an unlayered `!important`
// rule no stylesheet outranks; the taskbar recipe turns it to not-allowed, through the
// value, while nothing takes the drop (see refuseDrop in ./tether.ts).
const cursor = Cursor.configure({ cursor: "var(--_bar-drag-cursor, grabbing)" })
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
  return {
    members,
    name: members.length === 1 && only?.kind === "item" ? only.item.name : "",
    undocks: undocks(members),
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
    "sensors" | "plugins" | "onBeforeDragStart" | "onDragEnd"
  >
  readonly grab: (
    event: React.PointerEvent<HTMLElement>,
    member: BarMember,
    icon: LucideIcon,
    slot: string,
  ) => void
  readonly grabbed: LucideIcon | null
  readonly grabbedIconRef: (element: HTMLDivElement | null) => void
  // The modifiers of an icon that may leave the bar: held to it until pulled free.
  readonly pullOut: ReturnType<typeof PullOut.configure>[]
}

const tethered = (members: readonly BarMember[]): boolean =>
  members.some((member) => member.kind === "messages")

// An icon's pull off its bar: its modifiers, held to the bar until pulled free, which starts
// its drag in the session where the pointer is; and what the bar's drag tells it. Until it
// ends, it knows what the icon carries, whether it has broken free and where the pointer
// last was.
type BarPull = {
  readonly modifiers: ReturnType<typeof PullOut.configure>[]
  readonly start: (members: readonly BarMember[]) => void
  // Where the pointer is; whether the session follows it, once the icon broke free.
  readonly at: (x: number, y: number) => boolean
  // Where the pointer let go, past `bar`: as a move there would, it frees an icon flung far
  // enough in moves too quick for the drag to follow, as one that starts and ends it.
  readonly release: (x: number, y: number, bar: DOMRect | undefined) => boolean
  readonly end: () => void
}

const barPull = (session: DragSession, terminal: string): BarPull => {
  let drag: {
    readonly members: readonly BarMember[]
    free: boolean
    at: { x: number; y: number } | null
  } | null = null
  const loose = (): void => {
    if (!drag || drag.free) return
    drag.free = true
    session.start({ from: terminal, ...draggedOf(drag.members) })
    if (drag.at) session.move(drag.at.x, drag.at.y)
  }
  return {
    modifiers: [
      PullOut.configure({
        element: (dragged) => dragged?.closest("[data-taskbar]") ?? null,
        onPull: ({ free }) => {
          if (free) loose()
        },
      }),
    ],
    start: (members) => {
      drag = { members, free: false, at: null }
    },
    at: (x, y) => {
      if (drag) drag.at = { x, y }
      return drag?.free === true
    },
    release: (x, y, bar) => {
      if (drag && !drag.free && bar && !tethered(drag.members)) {
        const past = overflow({ left: x, right: x, top: y, bottom: y }, { x: 0, y: 0 }, bar)
        if (pull(past, defaultPull).free) loose()
      }
      return drag?.free === true
    },
    end: () => {
      drag = null
    },
  }
}

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

  const pulling = useMemo(() => barPull(session, terminal), [session, terminal])
  // Follows an icon's drag: a message's at once, another's only once pulled free.
  const followIcon = (members: readonly BarMember[], x: number, y: number): void => {
    if (pulling.at(x, y) || tethered(members)) follow(members, x, y)
  }

  const slotOf = (id: unknown): BarSlot | undefined => slots.find((slot) => slot.key === String(id))
  const provider: BarDragging["provider"] = {
    sensors,
    plugins,
    // From the move that starts the drag, before dnd-kit renders it as one, so no move
    // after that one goes unfollowed.
    onBeforeDragStart: (event) => {
      const members = slotOf(event.operation.source?.id)?.members ?? []
      pulling.start(members)
      // The drag keeps the pointer's moves to itself, so this listens ahead of it.
      const moved = (pointer: PointerEvent): void =>
        followIcon(members, pointer.clientX, pointer.clientY)
      window.addEventListener("pointermove", moved, { capture: true })
      stopFollowing.current = () =>
        window.removeEventListener("pointermove", moved, { capture: true })
    },
    onDragEnd: (event) => {
      stopFollowing.current?.()
      stopFollowing.current = undefined
      const { source } = event.operation
      const sortable = !event.canceled && isSortable(source)
      const before = import.meta.env.MODE === "test" ? session.drag.getSnapshot() : null
      // Where the bar's own drag left it, so the bar stays as its DOM shows it.
      if (sortable && source.initialIndex !== source.index) move(source.initialIndex, source.index)
      const members = sortable ? slotOf(source.id)?.members : undefined
      // It lands where it's let go, which the last move followed may not have reached.
      const { nativeEvent } = event
      if (members && nativeEvent instanceof PointerEvent) {
        const { clientX: x, clientY: y } = nativeEvent
        if (pulling.release(x, y, bar.current?.getBoundingClientRect()) || tethered(members))
          follow(members, x, y)
      }
      // A failed browser gesture needs the release decision, which a later screenshot
      // cannot recover. Only the behaviour tests collect this synchronous observation.
      if (import.meta.env.MODE === "test")
        window.dispatchEvent(
          new CustomEvent("novadeck:test-bar-drop", {
            detail: {
              source: source?.id,
              initialIndex: isSortable(source) ? source.initialIndex : undefined,
              index: isSortable(source) ? source.index : undefined,
              cancelled: event.canceled,
              nativeEvent,
              before,
              after: session.drag.getSnapshot(),
            },
          }),
        )
      pulling.end()
      finish(members, event.canceled)
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
    const slotIcon = bar.current?.querySelector(`[data-slot="${CSS.escape(slot)}"] .taskbar-item`)
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
        setGrabbed({ icon, from: slotIcon?.getBoundingClientRect() })
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
      if (!dragging) return
      // A cancelled pointer lands nowhere, as a cancelled icon drag goes back.
      const lost = pointer.type === "pointercancel"
      if (!lost) follow(members, pointer.clientX, pointer.clientY)
      settle(finish(members, lost))
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

  return {
    provider,
    grab,
    grabbed: grabbed?.icon ?? null,
    grabbedIconRef,
    pullOut: pulling.modifiers,
  }
}
