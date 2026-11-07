import { useEffect, useState } from "react"

// How much of a terminal's tile must be in sight to count as seen, with no margin: what the
// person can really see, not what a canvas keeps laid out around it.
export const seenFraction = 0.25

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

// Whether an observation counts as seen: a quarter of the tile is in sight.
export const seenIn = (
  entry: Pick<IntersectionObserverEntry, "isIntersecting" | "intersectionRatio">,
): boolean => entry.isIntersecting && entry.intersectionRatio >= seenFraction

// The scrolling view a tile sits in: the layout's own viewport, so a node filling the canvas
// counts as covering the view even with the sidebar and the companion pane taking the window's
// rest. Null (the window) where the tile is in none.
export const viewportOf = (element: Element): Element | null =>
  element.closest("[data-workspace-viewport]")

// Whether at least a quarter of `element` is really in sight. Used only while `enabled` (a
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
      { root: viewportOf(element), threshold: seenFraction },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
      setInSight(false)
    }
  }, [element, enabled, observable])
  return enabled && !observable ? true : inSight
}
