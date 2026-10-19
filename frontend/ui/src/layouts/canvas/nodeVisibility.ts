// How far past the viewport's edges a node still counts as on screen: about one node's size
// at the default zoom (550 by 400), so a node panned in from an edge has been in sight, and
// has its screen, a little before it crosses the edge.
const margin = "400px 550px"

// Which of the canvas's nodes the person can see. One observer, rooted at the canvas's
// clipping element, watches every node's element.
export type NodeVisibility = {
  // Starts watching a node's element; returns the stop.
  readonly watch: (id: string, element: Element) => () => void
  readonly subscribe: (listener: () => void) => () => void
  // Whether the node is on screen; undefined until the observer first reports on it. Where
  // the browser has no observer, every node is on screen.
  readonly onScreen: (id: string) => boolean | undefined
}

export const createNodeVisibility = (): NodeVisibility => {
  const reported = new Map<string, boolean>()
  const ids = new Map<Element, string>()
  const listeners = new Set<() => void>()
  let observer: IntersectionObserver | undefined
  const report = (entries: readonly IntersectionObserverEntry[]): void => {
    let changed = false
    // Entries come in order, so the last one for a node is where it is now.
    for (const { target, isIntersecting } of entries) {
      const id = ids.get(target)
      if (id === undefined || reported.get(id) === isIntersecting) continue
      reported.set(id, isIntersecting)
      changed = true
    }
    if (changed) for (const listener of listeners) listener()
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
    onScreen: (id) => (typeof IntersectionObserver === "undefined" ? true : reported.get(id)),
  }
}
