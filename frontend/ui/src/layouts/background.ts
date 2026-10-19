import type { PointerEvent } from "react"

const clearPointer = (event: PointerEvent<HTMLDivElement>): void => {
  delete event.currentTarget.dataset.pointerInside
}

export const backgroundPointerHandlers = {
  onPointerMove: (event: PointerEvent<HTMLDivElement>): void => {
    if (event.pointerType === "touch") return
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
