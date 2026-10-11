import type { DragDropManager } from "@dnd-kit/dom"
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react"

import type { PinHandoff, Point } from "./pin-drop"
import { ease, slide } from "./pin-motion"

// Where in a pin the bar's drag of it is held: a little in from its start, halfway down.
const grip = 20

export type PinHandoffDrag = {
  // The handed-over project whose pin isn't under the pointer yet, and shows unseen.
  readonly arriving: string | null
  // Takes the bar's drag manager, which runs the handed-over drag.
  readonly takeManager: (manager: DragDropManager | null) => void
  // The bar's drag is over: whether it was a handed-over one, and where the pointer let it
  // go, if it did (where it is let go decides, even if no move came after the drag got
  // under way).
  readonly end: () => { readonly handedOver: boolean; readonly releasedAt: Point | null }
}

// Takes a drag the switcher's list handed to the pins bar: once the project is among the
// pins (`pinned`) and its pin shows in `row`, the bar's own drag of that pin starts, and
// follows the pointer until it lets go, or Escape or a canceled pointer cancels it. The pin
// waits unseen until the drag is under way, then fades in where the pointer is. Where the
// bar can't start that drag, `onAbandon` is told, so the handoff doesn't hang.
export const usePinHandoff = (
  handoff: PinHandoff | null,
  pinned: boolean,
  row: React.RefObject<HTMLElement | null>,
  onAbandon: () => void,
): PinHandoffDrag => {
  const abandon = useEffectEvent(onAbandon)
  const manager = useRef<DragDropManager | null>(null)
  const takeManager = useCallback((next: DragDropManager | null) => {
    manager.current = next
  }, [])
  // The handoff the bar is dragging, and where the pointer let it go.
  const took = useRef<PinHandoff | null>(null)
  const releasedAt = useRef<Point | null>(null)
  // The handed-over pin is under the pointer.
  const [landed, setLanded] = useState<PinHandoff | null>(null)
  const following = useRef<(() => void) | null>(null)

  useLayoutEffect(() => {
    if (!handoff || !pinned || took.current === handoff) return
    const actions = manager.current?.actions
    const pin = row.current?.querySelector<HTMLElement>(
      `.pin[data-pin="${CSS.escape(handoff.id)}"]`,
    )
    if (!actions || !pin) {
      abandon()
      return
    }
    took.current = handoff
    releasedAt.current = null
    const box = pin.getBoundingClientRect()
    try {
      actions.start({
        source: handoff.id,
        coordinates: { x: box.left + grip, y: box.top + box.height / 2 },
      })
    } catch {
      took.current = null
      abandon()
      return
    }
    // dnd-kit takes moves only once the drag is under way, a frame or so after it starts.
    let pointer = handoff.point
    let frame = requestAnimationFrame(function arrive(): void {
      if (!manager.current?.dragOperation.status.dragging) {
        frame = requestAnimationFrame(arrive)
        return
      }
      actions.move({ to: pointer })
      // dnd-kit sets the dragged pin's transitions, so the fade is an animation of its own;
      // it starts part way, so the pin is seen at once where the pointer is.
      pin.animate([{ filter: "opacity(0.4)" }, { filter: "opacity(1)" }], {
        duration: slide(),
        easing: ease,
      })
      setLanded(handoff)
    })
    const move = (event: PointerEvent): void => {
      pointer = { x: event.clientX, y: event.clientY }
      actions.move({ to: pointer, event })
    }
    const drop = (event: PointerEvent): void => {
      releasedAt.current = { x: event.clientX, y: event.clientY }
      actions.stop({ event })
    }
    const cancel = (): void => actions.stop({ canceled: true })
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return
      event.preventDefault()
      event.stopPropagation()
      cancel()
    }
    window.addEventListener("pointermove", move, true)
    window.addEventListener("pointerup", drop, true)
    window.addEventListener("pointercancel", cancel, true)
    window.addEventListener("keydown", escape, true)
    following.current = () => {
      cancelAnimationFrame(frame)
      window.removeEventListener("pointermove", move, true)
      window.removeEventListener("pointerup", drop, true)
      window.removeEventListener("pointercancel", cancel, true)
      window.removeEventListener("keydown", escape, true)
    }
  }, [handoff, pinned, row])
  useEffect(() => () => following.current?.(), [])

  const end = useCallback(() => {
    if (took.current === null) return { handedOver: false, releasedAt: null }
    following.current?.()
    following.current = null
    took.current = null
    return { handedOver: true, releasedAt: releasedAt.current }
  }, [])

  return {
    arriving: handoff && landed !== handoff ? handoff.id : null,
    takeManager,
    end,
  }
}
