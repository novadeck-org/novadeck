import { useEffect, useRef } from "react"

// What a trigger offers on hover, a tooltip or a peek, waits for the pointer to rest on
// it: every move over the trigger starts the wait again, so sweeping across opens
// nothing. Pressing it, or leaving, gives up the wait, and after a press the trigger
// waits for the pointer to leave before it offers anything again. A touch never rests.
export type RestingPointer = {
  // Whether the pointer is over the trigger now.
  readonly over: () => boolean
  readonly handlers: {
    readonly onPointerMove: (event: React.PointerEvent) => void
    readonly onPointerLeave: () => void
    readonly onPointerDown: () => void
  }
}

export const useRestingPointer = (delay: number, onRest: () => void): RestingPointer => {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const over = useRef(false)
  const pressed = useRef(false)
  // The latest, so a wait already running calls what the trigger offers now.
  const rest = useRef(onRest)
  useEffect(() => {
    rest.current = onRest
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  const cancel = (): void => {
    clearTimeout(timer.current)
    timer.current = undefined
  }
  return {
    over: () => over.current,
    handlers: {
      onPointerMove: (event) => {
        if (event.pointerType === "touch") return
        over.current = true
        cancel()
        if (!pressed.current) timer.current = setTimeout(() => rest.current(), delay)
      },
      onPointerLeave: () => {
        over.current = false
        pressed.current = false
        cancel()
      },
      onPointerDown: () => {
        pressed.current = true
        cancel()
      },
    },
  }
}
