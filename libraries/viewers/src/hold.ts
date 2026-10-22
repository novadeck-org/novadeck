// Holding a viewer's place while its size arrives. A place set before the viewer has its
// size, as when it mounts out of sight (a parked terminal), while its pane settles, or
// before an image has loaded, is set again as the size of what it watches changes, until
// a moment after the viewer first has a size and what it holds is ready, or until the
// person, or anything else, scrolls it.

export type Hold = {
  /** Sets the place now, and again as the size arrives. */
  readonly hold: (place: () => void) => void
  /** Stops setting it. */
  readonly release: () => void
  /** Sets it again, as a size change would: for what's ready without changing size. */
  readonly refresh: () => void
}

export const createHold = (
  root: HTMLElement,
  watched: () => readonly Element[],
  // Whether what it holds has all it needs for its size, as an image once it has loaded:
  // the moment starts only then.
  ready: () => boolean = () => true,
  // Called as a hold starts and as it ends, as for a viewer to keep the browser's own
  // scroll anchoring from moving what it holds, which would pass for the person's scroll.
  around?: { readonly start: () => void; readonly stop: () => void },
): Hold => {
  let release: (() => void) | undefined
  let settle: (() => void) | undefined
  const hold = (place: () => void): void => {
    release?.()
    around?.start()
    // Where it last put the viewer: a scroll anywhere else is someone else's.
    let placed = { top: -1, left: -1 }
    const put = (): void => {
      place()
      placed = { top: root.scrollTop, left: root.scrollLeft }
    }
    put()
    const Observer = root.ownerDocument.defaultView?.ResizeObserver
    if (!Observer) return around?.stop()
    let timer: ReturnType<typeof setTimeout> | undefined
    // Moved since it put it there, unless only cut short as what it holds shrank: a
    // scroll whose event may not have come yet.
    const moved = (): boolean => {
      const { scrollTop: top, scrollLeft: left } = root
      const { scrollHeight, clientHeight, scrollWidth, clientWidth } = root
      const clampedTop = top < placed.top && top >= scrollHeight - clientHeight - 1
      const clampedLeft = left < placed.left && left >= scrollWidth - clientWidth - 1
      return (top !== placed.top && !clampedTop) || (left !== placed.left && !clampedLeft)
    }
    settle = () => {
      if (moved()) return release?.()
      put()
      if (root.clientHeight && ready() && timer === undefined)
        timer = setTimeout(() => release?.(), 1000)
    }
    const observer = new Observer(settle)
    const letGo = (): void => release?.()
    const scrolled = (): void => {
      if (moved()) letGo()
    }
    const inputs = ["wheel", "pointerdown", "keydown", "touchstart"] as const
    release = () => {
      observer.disconnect()
      clearTimeout(timer)
      for (const input of inputs) root.removeEventListener(input, letGo)
      root.removeEventListener("scroll", scrolled)
      around?.stop()
      release = undefined
      settle = undefined
    }
    for (const input of inputs) root.addEventListener(input, letGo, { passive: true })
    root.addEventListener("scroll", scrolled, { passive: true })
    for (const element of [root, ...watched()]) observer.observe(element)
  }
  return { hold, release: () => release?.(), refresh: () => settle?.() }
}
