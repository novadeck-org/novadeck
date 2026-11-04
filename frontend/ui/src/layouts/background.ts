import type { PointerEvent } from "react"

const clearPointer = (event: PointerEvent<HTMLDivElement>): void => {
  delete event.currentTarget.dataset.pointerInside
}

// The windows on each view's ground: Focus's, Grid's cells and Canvas's nodes, with
// what they hold. A window hides the ground beneath it, so the spotlight there is never
// seen, and moving it would only repaint the whole dot layer on every move.
const windows = ".terminal-visibility, .grid-terminal, .react-flow__node"

const overWindow = (event: PointerEvent<HTMLDivElement>): boolean =>
  event.target instanceof Element && event.target.closest(windows) !== null

export const backgroundPointerHandlers = {
  onPointerMove: (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "touch") return
    // Over a window the spotlight fades out, as when the pointer leaves the workspace,
    // and comes back where the pointer reaches the ground again.
    if (overWindow(event)) {
      clearPointer(event)
      return
    }
    const surface = event.currentTarget
    const spotlight = surface.querySelector<HTMLElement | SVGElement>(".canvas-grid-spotlight")
    if (!spotlight) return
    const bounds = surface.getBoundingClientRect()
    // These coordinates belong to the effect, not every terminal beneath the workspace.
    spotlight.style.setProperty("--canvas-pointer-x", `${event.clientX - bounds.left}px`)
    spotlight.style.setProperty(
      "--canvas-pointer-y",
      `${event.clientY - bounds.top - surface.clientTop}px`,
    )
    if (!surface.dataset.pointerInside) surface.dataset.pointerInside = "true"
  },
  onPointerLeave: clearPointer,
  onPointerCancel: clearPointer,
}
