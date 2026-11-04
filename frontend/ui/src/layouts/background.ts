import type { PointerEvent } from "react"

const clearPointer = (event: PointerEvent<HTMLDivElement>): void => {
  delete event.currentTarget.dataset.pointerInside
}

// The windows that hide the ground beneath them, where the spotlight is never seen and
// moving it would only repaint the whole dot layer on every move: Focus's window, a Grid
// cell and a Canvas node, except those that recede and let the ground show through
// (grid.css, canvas.css): a selected preview, and in Canvas while one is selected, every
// node outside the selected one and its team.
const opaqueWindows = [
  ".focus-stage > .terminal-visibility",
  '.grid-terminal:not(.selected[data-preview="true"])',
  '.canvas-viewport[data-has-selection="false"] .react-flow__node',
  '.react-flow__node:has(> .canvas-node:is(.selected, [data-team]):not([data-preview="true"]))',
].join(", ")

// Over an opaque window, or over a portal such as a terminal's menu, which reaches the
// ground through React but lies over it, not on it.
const overWindow = (event: PointerEvent<HTMLDivElement>): boolean =>
  !(event.target instanceof Node) ||
  !event.currentTarget.contains(event.target) ||
  (event.target instanceof Element && event.target.closest(opaqueWindows) !== null)

export const backgroundPointerHandlers = {
  onPointerMove: (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "touch") return
    // There the spotlight fades out, as when the pointer leaves the workspace, and comes
    // back where the pointer reaches the ground again.
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
