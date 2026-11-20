import { useCallback, useEffect, useLayoutEffect, useRef } from "react"

// An update (a `done` report or a `tell`) is read by a visit to the Inbox's list: its row is
// seen once it has been in sight for a moment while the window has the person's focus, and
// read when the person then leaves the list (its panel closes or gives way to another, the
// window loses their focus, or a dialog covers it). So a row never turns resolved under their
// eyes: it is new for as long as they look, and history when they come back. A glance while
// scrolling past sees nothing, and neither does looking at the row's terminal.

// How long an update's row must stay in sight to count as seen.
export const sightDwellMs = 1000

// How much of the row must be in sight: half of it, so a row cut off at the list's edge isn't.
export const sightFraction = 0.5

// What the row's sight and the window's focus come to: `seen` once both have held for
// `dwellMs` without a break. Each break starts the wait again; `stop` ends it unseen.
export type SightReader = {
  readonly sight: (inSight: boolean) => void
  readonly focus: (focused: boolean) => void
  readonly stop: () => void
}

export const createSightReader = ({
  dwellMs = sightDwellMs,
  focused,
  seen,
}: {
  readonly dwellMs?: number
  // Whether the window has the person's focus as this starts.
  readonly focused: boolean
  readonly seen: () => void
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
        seen()
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

// Tells `seen` once the row `element` shows has been in sight for the dwell, while `unread`
// and while the person `looking` at the page: it has their focus and no dialog covers it, as
// the app's own focus says (`ui.pageFocused`, which counts the desktop app's frames as the
// page). Where the browser has no observer nothing is seen: the row is opened to be read.
export const useSight = (
  element: Element | null,
  unread: boolean,
  looking: boolean,
  seen: () => void,
): void => {
  const latest = useRef({ seen, looking })
  const reader = useRef<SightReader | null>(null)
  useLayoutEffect(() => {
    latest.current = { seen, looking }
  })
  useEffect(() => {
    if (!unread || !element || typeof IntersectionObserver === "undefined") return
    const current = createSightReader({
      focused: latest.current.looking,
      seen: () => latest.current.seen(),
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

// One visit to the Inbox's list, from when the person starts looking at it (`visiting`) to
// when they stop: returns what notes a row seen in it, by its key, and tells `read` the keys
// seen as the visit ends, or as the list is taken down. A visit that saw nothing reads
// nothing, and one the window closes on (a quit, a reload) reads nothing either: what was
// seen in it is new again at the next start.
export const useReadOnLeaving = (
  visiting: boolean,
  read: (keys: ReadonlySet<string>) => void,
): ((key: string) => void) => {
  const seen = useRef(new Set<string>())
  const latest = useRef(read)
  useLayoutEffect(() => {
    latest.current = read
  })
  useEffect(() => {
    if (!visiting) return
    return () => {
      const keys = seen.current
      seen.current = new Set()
      if (keys.size > 0) latest.current(keys)
    }
  }, [visiting])
  return useCallback((key: string) => void seen.current.add(key), [])
}
