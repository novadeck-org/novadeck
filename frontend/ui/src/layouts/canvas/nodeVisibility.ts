import { createAdmission } from "./admission"

// How far past the viewport's edges a node still counts as on screen: about one node's size
// at the default zoom (550 by 400), so a node panned in from an edge has been in sight, and
// has its screen, a little before it crosses the edge.
const margin = "400px 550px"

// Which of the canvas's nodes the person can see. One observer, rooted at the canvas's
// clipping element, watches every node's element. A node in sight is admitted to its screen
// in turns (see admission.ts), so a view full of nodes does not take them all in one frame.
export type NodeVisibility = {
  // Starts watching a node's element; returns the stop.
  readonly watch: (id: string, element: Element) => () => void
  readonly subscribe: (listener: () => void) => () => void
  // The node whose screen is taken as soon as it is in sight, without waiting its turn.
  readonly select: (id: string | undefined) => void
  // Whether the node is on screen; undefined until the observer first reports on it and, once
  // it is in sight, until its turn. Where the browser has no observer, every node is on screen.
  readonly onScreen: (id: string) => boolean | undefined
}

export const createNodeVisibility = (): NodeVisibility => {
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
    // Entries come in order, so the last one for a node is where it is now.
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
      observer ??= new IntersectionObserver(report, {
        // The clipping element, not `.canvas-viewport` above it: React Flow's `.react-flow`
        // wrapper sits between them with `overflow: hidden`, and an intermediate clip is
        // applied to a target before the root's margin grows the root, so a margin on the
        // outer root would never reach past it. As the root, it is the clip the margin
        // extends, with no newer observer option (`scrollMargin`) to depend on.
        root: element.closest(".react-flow"),
        rootMargin: margin,
      })
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
