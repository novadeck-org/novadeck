import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react"

import { blockingOverlayOpen } from "../interaction/dom"

// Notes in `lost` that the notice (the element matching `selector`) went away while focus
// was inside it.
export const KeepFocus = ({
  lost,
  selector,
}: {
  readonly lost: { current: boolean }
  readonly selector: string
}): null => {
  useLayoutEffect(
    () => () => {
      if (document.activeElement?.closest(selector)) lost.current = true
    },
    [lost, selector],
  )
  return null
}

// Focus inside a notice when it went away unanswered, as for a dialog the person opened
// from it: the dialog would return to a button that is gone, so focus goes to the chip
// once nothing else has it. Waits while the notice is held back (`away`).
// Returns the `lost` note for `KeepFocus`.
export const useRecoverFocus = (
  away: boolean,
  chip: RefObject<HTMLButtonElement | null>,
): { current: boolean } => {
  const lost = useRef(false)
  useEffect(() => {
    if (away || !lost.current) return undefined
    lost.current = false
    let frame = 0
    let tries = 0
    const check = (): void => {
      const active = document.activeElement
      if (active && active !== document.body) return
      tries += 1
      if (tries > 60) return
      if (tries > 2) chip.current?.focus()
      else frame = requestAnimationFrame(check)
    }
    frame = requestAnimationFrame(check)
    return () => cancelAnimationFrame(frame)
  }, [away, chip])
  return lost
}

// Whether a dialog, menu or popover is open, looked at while `active`: they come and go
// in portals, so there is nothing to subscribe to. Looked at as `active` begins, so an
// offer that arrives with one open never shows, and then every 150 ms.
export const useOverlayOpen = (active: boolean): boolean => {
  const [was, setWas] = useState(false)
  const [open, setOpen] = useState(false)
  if (active !== was) {
    setWas(active)
    setOpen(active && blockingOverlayOpen())
  }
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setOpen(blockingOverlayOpen()), 150)
    return () => clearInterval(timer)
  }, [active])
  return active && open
}
