import type { EditorView } from "@codemirror/view"

// How far below the top of the pane a line lands.
const margin = 24

// The nearest ancestor that scrolls on its own: the pane's, never the app's clipped
// containers.
const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  for (let at = element.parentElement; at; at = at.parentElement)
    if (/^(auto|scroll)$/.test(getComputedStyle(at).overflowY)) return at
  return null
}

// Brings the line at `at` to the top of the pane, smoothly unless motion is reduced.
// Only the pane's scroller moves: CodeMirror's scrollIntoView also scrolls every
// ancestor whose content overflows, clipped ones included, which shifts the whole app.
// Lines out of view have estimated heights, so once the scroll stops, or a frame after an
// instant one, it corrects for where the line really is, unless the user took over the
// scroll meanwhile.
export const scrollLineToTop = (view: EditorView, at: number): void => {
  const scroller = scrollerOf(view.dom)
  if (!scroller) return
  // Where the scroller has to be, within what it can reach.
  const target = (): number =>
    Math.min(
      Math.max(
        0,
        scroller.scrollTop +
          view.documentTop +
          view.lineBlockAt(at).top -
          scroller.getBoundingClientRect().top -
          margin,
      ),
      scroller.scrollHeight - scroller.clientHeight,
    )
  const off = (): boolean => Math.abs(target() - scroller.scrollTop) >= 1
  // Already there, or as near as it goes: nothing moves, so nothing waits for a stop.
  if (!off()) return
  const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches
  scroller.scrollTo({ top: target(), behavior: smooth ? "smooth" : "instant" })
  if (!smooth) {
    // The editor measures what came into view on the next frame; then it settles.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        if (off()) scroller.scrollTo({ top: target(), behavior: "instant" })
      }),
    )
    return
  }
  const done = new AbortController()
  const { signal } = done
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
    scroller.addEventListener(type, () => done.abort(), { signal, passive: true })
  scroller.addEventListener(
    "scrollend",
    () => {
      done.abort()
      if (off()) scroller.scrollTo({ top: target(), behavior: "smooth" })
    },
    { signal },
  )
  // A scroll that never reports its end leaves nothing behind.
  setTimeout(() => done.abort(), 2000)
}
