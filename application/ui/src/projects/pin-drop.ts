import { createContext, useContext, useSyncExternalStore } from "react"

import type { ProjectArrangement } from "./project-arrangement"

export type Point = { readonly x: number; readonly y: number }

// A project dragged in the switcher's list, while that drag lasts: whether the pins bar
// can take it (it is pinned, or a pin is free).
export type PinDrag = { readonly id: string; readonly accepts: boolean }

// A drag the switcher's list handed to the pins bar as it left the list: the project,
// pinned by then, where the pointer was, from which the bar drags its pin on, and whether
// it was pinned before, which it stays however the drag ends.
export type PinHandoff = {
  readonly id: string
  readonly point: Point
  readonly wasPinned: boolean
}

export type PinDropState = { readonly drag: PinDrag | null; readonly handoff: PinHandoff | null }

// What the channel does to the arrangement, which is the caller's: pins a project at a
// place among the pins, and reads and puts back the whole arrangement.
export type PinDropArrangement = {
  readonly pin: (id: string, index: number) => void
  readonly current: () => ProjectArrangement
  readonly restore: (arrangement: ProjectArrangement) => void
}

// Carries a drag from the switcher's list to the pins bar, which are apart in the tree.
// The list tells where its drag starts and ends; once the drag leaves the list it hands
// it over: the project is pinned at once, where the pointer is along the bar (or last),
// and the bar goes on with a drag of that pin, as a reorder, so the person drags one pin
// from then on. Let go off the bar, or canceled, the arrangement goes back to how it was
// before the handoff.
export type PinDropChannel = {
  readonly getSnapshot: () => PinDropState
  readonly subscribe: (listener: () => void) => () => void
  // The bar's place for a point among its pins, the dragged project's own aside.
  readonly setLocate: (locate: ((point: Point, id: string) => number) | null) => void
  readonly start: (id: string, accepts: boolean) => void
  // Pins the dragged project and hands its drag to the bar; false where the bar can't
  // take it.
  readonly handOff: (point: Point) => boolean
  // The list's drag is over, handed off or not.
  readonly end: () => void
  // The bar's drag of the handed-off pin is over, or the bar couldn't take it: `restore`
  // puts the arrangement back as it was before the handoff.
  readonly settle: (restore: boolean) => void
}

const idle: PinDropState = { drag: null, handoff: null }

export const createPinDrop = (arrangement: PinDropArrangement): PinDropChannel => {
  let state = idle
  let locate: ((point: Point, id: string) => number) | null = null
  // The arrangement before the handed-off drag pinned its project.
  let before: ProjectArrangement | null = null
  const listeners = new Set<() => void>()
  const set = (next: PinDropState): void => {
    state = next
    for (const listener of listeners) listener()
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    setLocate: (next) => {
      locate = next
    },
    start: (id, accepts) => set({ ...state, drag: { id, accepts } }),
    handOff: (point) => {
      const { drag } = state
      if (!drag?.accepts || state.handoff) return false
      before = arrangement.current()
      const index = locate ? locate(point, drag.id) : Number.MAX_SAFE_INTEGER
      // Told first, so the bar knows the pin as handed over from the render it shows in.
      const wasPinned = before.pinned.includes(drag.id)
      set({ drag, handoff: { id: drag.id, point, wasPinned } })
      arrangement.pin(drag.id, index)
      return true
    },
    end: () => {
      if (state.drag) set({ ...state, drag: null })
    },
    settle: (restore) => {
      if (restore && before) arrangement.restore(before)
      before = null
      if (state.handoff) set({ ...state, handoff: null })
    },
  }
}

export const PinDropContext = createContext<PinDropChannel | null>(null)

const none = (): (() => void) => () => {}
const nothing = (): PinDropState => idle

// The channel, where one is given, and the drags it carries now.
export const usePinDrop = (): { channel: PinDropChannel | null } & PinDropState => {
  const channel = useContext(PinDropContext)
  const state = useSyncExternalStore(
    channel?.subscribe ?? none,
    channel?.getSnapshot ?? nothing,
    nothing,
  )
  return { channel, ...state }
}
