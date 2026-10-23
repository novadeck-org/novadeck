// How many device pixels a CSS pixel of an element covers: the screen's ratio, times any
// zoom of the view around it, as Canvas scales a node and the sheet beside it.
export const deviceScale = (element: HTMLElement): number => {
  const ratio = window.devicePixelRatio || 1
  const width = element.offsetWidth
  const zoom = width > 0 ? element.getBoundingClientRect().width / width : 1
  return ratio * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1)
}

// Calls each listener when the scale may have changed: the window moved to a screen of
// another ratio, the page was zoomed or resized, or the view was zoomed by the wheel or a
// pinch, once the gesture settles. One set of listeners for every avatar; returns the stop.
const listeners = new Set<() => void>()
let stopWatching: (() => void) | null = null

const watch = (): (() => void) => {
  let timer: ReturnType<typeof setTimeout> | undefined
  const settle = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      for (const listener of listeners) listener()
    }, 150)
  }
  let media: MediaQueryList | null = null
  const ratio = (): void => {
    media?.removeEventListener("change", ratio)
    media = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
    media.addEventListener("change", ratio)
    settle()
  }
  ratio()
  window.addEventListener("resize", settle)
  window.addEventListener("wheel", settle, { passive: true })
  window.addEventListener("pointerup", settle)
  return () => {
    clearTimeout(timer)
    media?.removeEventListener("change", ratio)
    window.removeEventListener("resize", settle)
    window.removeEventListener("wheel", settle)
    window.removeEventListener("pointerup", settle)
  }
}

export const onScaleChange = (listener: () => void): (() => void) => {
  listeners.add(listener)
  if (!stopWatching && typeof window.matchMedia === "function") stopWatching = watch()
  return () => {
    listeners.delete(listener)
    if (listeners.size || !stopWatching) return
    stopWatching()
    stopWatching = null
  }
}
