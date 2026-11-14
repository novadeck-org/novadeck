import { useEffect, useState, useSyncExternalStore, type RefObject } from "react"

import { createAdmission } from "./admission"

// Which of a layout's tiles (Canvas's nodes, Grid's windows) the person can see. One observer,
// rooted at the layout's clipping or scrolling element, watches every tile's element. A tile in
// sight is admitted to its screen in turns (see admission.ts), so a view full of tiles does not
// take them all in one frame.
export type TileVisibility = {
  // Starts watching a tile's element; returns the stop.
  readonly watch: (id: string, element: Element) => () => void
  readonly subscribe: (listener: () => void) => () => void
  // The tile whose screen is taken as soon as it is in sight, without waiting its turn.
  readonly select: (id: string | undefined) => void
  // Whether the tile is on screen; undefined until the observer first reports on it and, once
  // it is in sight, until its turn. Where the browser has no observer, every tile is on screen.
  readonly onScreen: (id: string) => boolean | undefined
}

export type TileVisibilityOptions = {
  // The element the observer is rooted at, found from a tile's element: the one whose clip the
  // margin extends. Null for the window.
  readonly root: (element: Element) => Element | null
  // How far past the root's edges a tile still counts as on screen, as `rootMargin`.
  readonly margin: string
}

export const createTileVisibility = ({ root, margin }: TileVisibilityOptions): TileVisibility => {
  const reported = new Map<string, boolean>()
  const ids = new Map<Element, string>()
  const listeners = new Set<() => void>()
  let observer: IntersectionObserver | undefined
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const admission = createAdmission(notify)
  const report = (entries: readonly IntersectionObserverEntry[]): void => {
    let changed = false
    // Entries come in order, so the last one for a tile is where it is now.
    for (const { target, isIntersecting, boundingClientRect: box, rootBounds } of entries) {
      const id = ids.get(target)
      if (id === undefined || reported.get(id) === isIntersecting) continue
      reported.set(id, isIntersecting)
      changed = true
      if (!isIntersecting) admission.drop(id)
      else if (!rootBounds) admission.want(id, 0)
      else {
        const x = box.x + box.width / 2 - (rootBounds.x + rootBounds.width / 2)
        const y = box.y + box.height / 2 - (rootBounds.y + rootBounds.height / 2)
        admission.want(id, Math.hypot(x, y))
      }
    }
    if (changed) notify()
  }
  return {
    watch: (id, element) => {
      if (typeof IntersectionObserver === "undefined") return () => {}
      observer ??= new IntersectionObserver(report, { root: root(element), rootMargin: margin })
      ids.set(element, id)
      observer.observe(element)
      return () => {
        observer?.unobserve(element)
        ids.delete(element)
        reported.delete(id)
        admission.drop(id)
        if (!ids.size) {
          observer?.disconnect()
          observer = undefined
        }
      }
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    select: admission.select,
    onScreen: (id) => {
      if (typeof IntersectionObserver === "undefined") return true
      const seen = reported.get(id)
      return seen && !admission.admitted(id) ? undefined : seen
    },
  }
}

// How long a tile out of sight waits before its content stops being laid out: past the 5 s
// a runner screen nobody shows keeps following before it parks (`parkMs`, in
// libraries/terminal/src/view/screens.ts, which a layout does not import), so the screen has measured and
// parked first.
const hideMs = 6_000

// Where a tile stands: on screen once it is in sight and its turn has come (a tile the
// observer has not reported on has not been seen, so its screen opens once it is), and off
// screen once it has been out of sight for a while. It shows again in the render that sees it
// back, before its surface takes its screen, so xterm measures a laid-out element.
export const useTileOnScreen = (
  visibility: TileVisibility,
  id: string,
  // The tile's element, set by the time effects run.
  element: RefObject<Element | null>,
): { readonly onScreen: boolean; readonly offScreen: boolean } => {
  const reported = useSyncExternalStore(visibility.subscribe, () => visibility.onScreen(id))
  const [waited, setWaited] = useState(false)
  useEffect(() => {
    const watched = element.current
    return watched ? visibility.watch(id, watched) : undefined
  }, [visibility, id, element])
  useEffect(() => {
    if (reported !== false) return
    const timer = setTimeout(() => setWaited(true), hideMs)
    return () => {
      clearTimeout(timer)
      setWaited(false)
    }
  }, [reported])
  return { onScreen: reported === true, offScreen: reported === false && waited }
}
