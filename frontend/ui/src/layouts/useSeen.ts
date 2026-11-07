import { useEffect, useState } from "react"

// How much of a terminal's tile must be in sight to count as seen, with no margin: what the
// person can really see, not what a canvas keeps laid out around it.
export const seenFraction = 0.25

// How much of the viewport a tile's visible part must cover to count as seen, for a tile so
// large (a Canvas node zoomed in) that no quarter of it is ever in sight.
export const coveredFraction = 0.5

// The zoom from which a Canvas node's text can be read; below it the node is an overview
// tile and is not seen.
export const legibleZoom = 0.5

const hidden = (): boolean => typeof document !== "undefined" && document.hidden

// Whether the page is visible: false while the window is minimized or fully covered.
export const usePageVisible = (): boolean => {
  const [visible, setVisible] = useState(() => !hidden())
  useEffect(() => {
    const update = (): void => setVisible(!hidden())
    update()
    document.addEventListener("visibilitychange", update)
    return () => document.removeEventListener("visibilitychange", update)
  }, [])
  return visible
}

// Whether an observation counts as seen: a quarter of the tile is in sight, or what is in
// sight covers most of the viewport.
export const seenIn = (
  entry: Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio"> & {
    readonly intersectionRect: { readonly width: number; readonly height: number }
    readonly rootBounds: { readonly width: number; readonly height: number } | null
  },
): boolean => {
  if (!entry.isIntersecting) return false
  if (entry.intersectionRatio >= seenFraction) return true
  const root = entry.rootBounds
  if (!root || root.width <= 0 || root.height <= 0) return false
  const covered =
    (entry.intersectionRect.width * entry.intersectionRect.height) / (root.width * root.height)
  return covered >= coveredFraction
}

// Fine steps up to the quarter, so a tile far larger than the view still reports as it
// grows to cover it.
const thresholds = Array.from({ length: 26 }, (_, step) => step / 100)

// Whether at least a quarter of `element` is really in sight, or it fills most of the view. Used only while `enabled` (a
// sleeping terminal's tile), so a running one costs no observer. Where the browser has no
// observer it counts as in sight, as Canvas does for its nodes.
export const useInSight = (element: Element | null, enabled: boolean): boolean => {
  const observable = typeof IntersectionObserver !== "undefined"
  const [inSight, setInSight] = useState(false)
  useEffect(() => {
    if (!enabled || !element || !observable) return
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1)
        if (last) setInSight(seenIn(last))
      },
      { threshold: thresholds },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      setInSight(false)
    }
  }, [element, enabled, observable])
  return enabled && !observable ? true : inSight
}
