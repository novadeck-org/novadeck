import type { CanvasLayout } from "@novadeck/core/types"

type Viewport = NonNullable<CanvasLayout["viewport"]>
type Flight = { viewport: Viewport }

// A single visit, scoped to the mounted Canvas; this is not a camera history.
export const createCanvasVisit = () => {
  let origin: { id: string; viewport: Viewport } | null = null
  let active: Flight | null = null
  let backRequested = false
  const begin = (id: string, current: Viewport, destination: Viewport): Flight | null => {
    if (active) return null
    if (origin?.id === id) {
      active = { viewport: origin.viewport }
      origin = null
    } else {
      origin = { id, viewport: { ...current } }
      active = { viewport: { ...destination } }
    }
    return active
  }
  return {
    get flying(): boolean {
      return active !== null
    },
    get visiting(): boolean {
      return origin !== null || active !== null
    },
    // Where the camera rests once the visit is over: where it began, or where a flight
    // back is headed; null outside a visit.
    get home(): Viewport | null {
      return origin?.viewport ?? active?.viewport ?? null
    },
    // A header's double-click: flies in to the terminal, or back from the one visited.
    begin,
    // Going to a terminal from outside the canvas, as from a notification: flies in as
    // `begin` does, but never back, so a visit already at (or flying to) the terminal stays.
    // One asked during another flight takes over from it, its way back where that visit's was.
    enter(id: string, current: Viewport, destination: Viewport): Flight | null {
      if (origin?.id === id) {
        // Under way to it with a way back asked for: it stays, as asked now.
        backRequested = false
        return null
      }
      if (!active) return begin(id, current, destination)
      const home = origin?.viewport ?? active.viewport
      origin = { id, viewport: { ...home } }
      active = { viewport: { ...destination } }
      backRequested = false
      return active
    },
    back(): Flight | null {
      if (active) {
        if (origin) backRequested = true
        return null
      }
      if (!origin) return null
      active = { viewport: origin.viewport }
      origin = null
      return active
    },
    finish(flight: Flight, completed = true): Flight | null {
      if (active !== flight) return null
      active = null
      if (!completed) {
        origin = null
        backRequested = false
        return null
      }
      if (backRequested && origin) {
        backRequested = false
        active = { viewport: origin.viewport }
        origin = null
        return active
      }
      return null
    },
    clear(): void {
      origin = null
      active = null
      backRequested = false
    },
  }
}
