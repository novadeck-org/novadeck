import { useEffect, useLayoutEffect, useRef } from "react"

// An update (a `done` report or a `tell`) is read once its row has been in sight in the Inbox
// list for a moment, while the window has the person's focus: its subject is often all there
// is to it, so seeing the row is reading it, as looking at its terminal is (the landing's
// `readDwellMs`). A glance while scrolling past reads nothing.

// How long an update's row must stay in sight to be read: the landing's dwell.
export const sightDwellMs = 1000

// How much of the row must be in sight: half of it, so a row cut off at the list's edge isn't.
export const sightFraction = 0.5

// What the row's sight and the window's focus come to: `read` once both have held for
// `dwellMs` without a break. Each break starts the wait again; `stop` ends it unread.
export type SightReader = {
  readonly sight: (inSight: boolean) => void
  readonly focus: (focused: boolean) => void
  readonly stop: () => void
}

export const createSightReader = ({
  dwellMs = sightDwellMs,
  focused,
  read,
}: {
  readonly dwellMs?: number
  // Whether the window has the person's focus as this starts.
  readonly focused: boolean
  readonly read: () => void
}): SightReader => {
  let inSight = false
  let hasFocus = focused
  let done = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const check = (): void => {
    const looking = !done && inSight && hasFocus
    if (looking && timer === undefined)
      timer = setTimeout(() => {
        timer = undefined
        done = true
        read()
      }, dwellMs)
    if (!looking && timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }
  return {
    sight: (next) => {
      inSight = next
      check()
    },
    focus: (next) => {
      hasFocus = next
      check()
    },
    stop: () => {
      done = true
      check()
    },
  }
}

const pageFocused = (): boolean => !document.hidden && document.hasFocus()

// Reads the row `element` shows once it has been in sight for the dwell, while `unread`.
// Where the browser has no observer nothing is read: the row is opened to be read.
export const useReadOnSight = (
  element: Element | null,
  unread: boolean,
  read: () => void,
): void => {
  const latest = useRef(read)
  useLayoutEffect(() => {
    latest.current = read
  })
  useEffect(() => {
    if (!unread || !element || typeof IntersectionObserver === "undefined") return
    const reader = createSightReader({
      focused: pageFocused(),
      read: () => latest.current(),
    })
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1)
        if (last) reader.sight(last.isIntersecting && last.intersectionRatio >= sightFraction)
      },
      { threshold: sightFraction },
    )
    observer.observe(element)
    const focus = (): void => reader.focus(pageFocused())
    window.addEventListener("focus", focus)
    window.addEventListener("blur", focus)
    document.addEventListener("visibilitychange", focus)
    return () => {
      reader.stop()
      observer.disconnect()
      window.removeEventListener("focus", focus)
      window.removeEventListener("blur", focus)
      document.removeEventListener("visibilitychange", focus)
    }
  }, [element, unread])
}
