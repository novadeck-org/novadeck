import { Background } from "@xyflow/react"
import type { PointerEvent } from "react"

// The app's Canvas view ground, for a React Flow canvas laid straight on the workspace:
// the dot grid every 24px, and a brighter patch of it that follows the pointer. Put
// `workspace` and `canvasPointer` on the element around the flow.
export const CanvasBackground = () => (
  <>
    <Background id="grid" className="canvas-grid" gap={24} size={1.6} bgColor="transparent" />
    <Background
      id="grid-spotlight"
      className="canvas-grid-spotlight"
      gap={24}
      size={1.6}
      bgColor="transparent"
    />
  </>
)

// The same ground for a page that is not a React Flow canvas: the grid and its spotlight
// drawn as images, fixed behind content that scrolls over them.
export const GroundDots = () => (
  <>
    <div aria-hidden="true" className="ground-dots canvas-grid absolute inset-0" />
    <div aria-hidden="true" className="ground-dots canvas-grid-spotlight absolute inset-0" />
  </>
)

const leave = (event: PointerEvent<HTMLElement>) => {
  delete event.currentTarget.dataset["pointerInside"]
}

export const canvasPointer = {
  onPointerMove: (event: PointerEvent<HTMLElement>) => {
    if (event.pointerType === "touch") return
    const surface = event.currentTarget
    const spotlight = surface.querySelector<SVGElement>(".canvas-grid-spotlight")
    if (!spotlight) return
    const bounds = surface.getBoundingClientRect()
    spotlight.style.setProperty("--canvas-pointer-x", `${event.clientX - bounds.left}px`)
    spotlight.style.setProperty("--canvas-pointer-y", `${event.clientY - bounds.top}px`)
    surface.dataset["pointerInside"] = "true"
  },
  onPointerLeave: leave,
  onPointerCancel: leave,
}
