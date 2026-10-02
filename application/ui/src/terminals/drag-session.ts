import { createContext, useContext, useRef, useSyncExternalStore } from "react"

import type { WindowPlace } from "../model/layout/window-place"
import { createStore, type Store } from "../model/store"

// Something dragged off a terminal's taskbar, while the pointer carries it: onto another
// terminal's taskbar, which shows it there, or into a view's free space, which opens it
// in a window of its own. One session serves the whole app: taskbars start and end drags,
// windows light up as drop targets, and views say where a window would open and show it.

// A view with free space to drop a window into, as Canvas and Grid have: where a window
// dropped at a point on screen opens, or null where that point isn't over its free space.
// A query: it changes nothing, and the same answer is the same object.
export type DropSpace = (x: number, y: number) => WindowPlace | null

export type BarDrag = {
  // The terminal whose taskbar it's dragged off.
  readonly from: string
  // What a window opened from it would be named.
  readonly name: string
  // Whether a drop on free space opens it in a window: one plan or one thing shown,
  // never a stack or something placed from another terminal.
  readonly undocks: boolean
  // The terminal window under the pointer, and whether the pointer is on its taskbar.
  readonly over: string | null
  readonly onBar: boolean
  // Where its window opens, while the pointer is over a view's free space.
  readonly place: WindowPlace | null
}

// What's under a point on screen, as the page lays it out.
export type HitTest = (
  x: number,
  y: number,
) => { readonly over: string | null; readonly onBar: boolean }

export type DragSession = {
  readonly drag: Store<BarDrag | null>
  // A view offers its free space while it's on screen; returns the withdrawal.
  readonly offer: (space: DropSpace) => () => void
  readonly start: (drag: Pick<BarDrag, "from" | "name" | "undocks">) => void
  readonly move: (x: number, y: number) => void
  // The drag is over: where it ended, or null when it was cancelled.
  readonly end: (cancelled?: boolean) => BarDrag | null
}

// Windows and taskbars say who they are by their data attributes: a window its terminal's
// id in `data-terminal`, a taskbar `data-taskbar`.
export const pageHitTest: HitTest = (x, y) => {
  const under = document.elementsFromPoint(x, y)
  const window = under.find((element) => element.matches("[data-terminal]"))
  const over = window?.getAttribute("data-terminal") ?? null
  const onBar = Boolean(
    window &&
    under.some(
      (element) =>
        element.matches("[data-taskbar]") && element.closest("[data-terminal]") === window,
    ),
  )
  return { over, onBar }
}

export const createDragSession = (hitTest: HitTest = pageHitTest): DragSession => {
  const drag = createStore<BarDrag | null>(null)
  const spaces = new Set<DropSpace>()
  const placeAt = (x: number, y: number): WindowPlace | null => {
    for (const space of spaces) {
      const place = space(x, y)
      if (place) return place
    }
    return null
  }
  return {
    drag,
    offer: (space) => {
      spaces.add(space)
      return () => spaces.delete(space)
    },
    start: (started) => drag.update(() => ({ ...started, over: null, onBar: false, place: null })),
    move: (x, y) =>
      drag.update((current) => {
        if (!current) return current
        const { over, onBar } = hitTest(x, y)
        // Over a window, nothing makes room: the window stays put for a drop on its bar.
        const place = !over && current.undocks ? placeAt(x, y) : null
        return current.over === over && current.onBar === onBar && current.place === place
          ? current
          : { ...current, over, onBar, place }
      }),
    end: (cancelled = false) => {
      const ended = drag.getSnapshot()
      drag.update(() => null)
      return cancelled ? null : ended
    },
  }
}

// The app's session, which its provider shares.
export const DragSessionContext = createContext<DragSession | null>(null)

export const useDragSession = (): DragSession => {
  const session = useContext(DragSessionContext)
  if (!session) throw new Error("useDragSession must be used inside a DragSessionContext")
  return session
}

// One part of the drag, so a component re-renders only when that part changes.
export const useDrag = <T>(
  select: (drag: BarDrag | null) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T => {
  const { drag } = useDragSession()
  const last = useRef<{ readonly value: T } | null>(null)
  return useSyncExternalStore(drag.subscribe, () => {
    const next = select(drag.getSnapshot())
    if (last.current && same(last.current.value, next)) return last.current.value
    last.current = { value: next }
    return next
  })
}
