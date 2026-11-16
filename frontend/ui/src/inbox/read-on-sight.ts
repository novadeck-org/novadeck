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

// Reads the row `element` shows once it has been in sight for the dwell, while `unread` and
// while the person `looking` at the page: it has their focus and no dialog covers it, as the
// app's own focus says (`ui.pageFocused`, which counts the desktop app's frames as the page).
// Where the browser has no observer nothing is read: the row is opened to be read.
export const useReadOnSight = (
  element: Element | null,
  unread: boolean,
  looking: boolean,
  read: () => void,
): void => {
  const latest = useRef({ read, looking })
  const reader = useRef<SightReader | null>(null)
  useLayoutEffect(() => {
    latest.current = { read, looking }
  })
  useEffect(() => {
    if (!unread || !element || typeof IntersectionObserver === "undefined") return
    const current = createSightReader({
      focused: latest.current.looking,
      read: () => latest.current.read(),
    })
    reader.current = current
    const observer = new IntersectionObserver(
      (entries) => {
        const last = entries.at(-1)
        if (last) current.sight(last.isIntersecting && last.intersectionRatio >= sightFraction)
      },
      { threshold: sightFraction },
    )
    observer.observe(element)
    return () => {
      current.stop()
      observer.disconnect()
      if (reader.current === current) reader.current = null
    }
  }, [element, unread])
  useEffect(() => {
    reader.current?.focus(looking)
  }, [looking])
}
