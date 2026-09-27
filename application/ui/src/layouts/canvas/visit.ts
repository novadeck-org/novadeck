import type { CanvasLayout } from "../../model/types"

type Viewport = NonNullable<CanvasLayout["viewport"]>
type Flight = { viewport: Viewport }

// A single visit, scoped to the mounted Canvas; this is not a camera history.
export const createCanvasVisit = () => {
  let origin: { id: string; viewport: Viewport } | null = null
  let active: Flight | null = null
  let backRequested = false
  return {
    get flying(): boolean {
      return active !== null
    },
    get visiting(): boolean {
      return origin !== null || active !== null
    },
    begin(id: string, current: Viewport, destination: Viewport): Flight | null {
      if (active) return null
      if (origin?.id === id) {
        active = { viewport: origin.viewport }
        origin = null
      } else {
        origin = { id, viewport: { ...current } }
        active = { viewport: { ...destination } }
      }
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
