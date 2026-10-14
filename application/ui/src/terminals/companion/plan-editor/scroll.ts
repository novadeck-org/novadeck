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
          (view.documentTop + view.lineBlockAt(at).top - scroller.getBoundingClientRect().top) /
            scaleOf(view) -
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

// Where the pane is scrolled in the plan: the line at its top, and how far down that line,
// as a share of its height, which holds across a narrower or zoomed pane.
export type PlanScroll = { readonly at: number; readonly into: number }

// How far the pane's top is into the document, in the page's pixels, which CodeMirror
// measures its lines in: scaled where Canvas zooms, or while the pane scales in.
const heightAtTop = (view: EditorView, scroller: HTMLElement): number =>
  scroller.getBoundingClientRect().top - view.documentTop

// How many page pixels a pixel of the pane's own scroll is. Over the whole editor, so
// rounding its height to whole pixels hardly matters.
const scaleOf = (view: EditorView): number => {
  const tall = view.dom.offsetHeight
  return tall ? view.dom.getBoundingClientRect().height / tall : 1
}

// Follows where the pane is scrolled in the plan, while it's on screen; returns the stop.
export const followScroll = (view: EditorView, on: (scroll: PlanScroll) => void): (() => void) => {
  const scroller = scrollerOf(view.dom)
  if (!scroller) return () => {}
  const note = (): void => {
    // Out of sight it has no size, and no place to note.
    if (!scroller.clientHeight) return
    // Above the first line, in the editor's padding, it's a negative share of it.
    const height = heightAtTop(view, scroller)
    const line = view.lineBlockAtHeight(height)
    on({ at: line.from, into: line.height ? (height - line.top) / line.height : 0 })
  }
  // Where it is now counts too, as a scroll that ended a restore and came before this,
  // once the editor has measured its padding.
  view.requestMeasure({ read: note })
  scroller.addEventListener("scroll", note, { passive: true })
  return () => scroller.removeEventListener("scroll", note)
}

// Scrolls the pane back to where `scroll` says, at once, then again each frame while the
// editor measures the lines that came into view, whose heights it had only estimated, or
// an edit moves the place; `done` once it holds still, after half a second, or once the
// person, or anything else, scrolls the pane. Holding still counts frames as well as time,
// and half a second frames as well as time: a busy machine draws few of them, and the
// editor measures and Canvas zooms the pane only in the ones it does (seen in CI, a restore
// that ended before either and left the pane a few lines off). Out of sight, it waits until
// the pane shows. Returns the finish, for an editor that closes or jumps elsewhere meanwhile.
export const restoreScroll = (
  view: EditorView,
  scroll: () => PlanScroll | null,
  done: () => void,
): (() => void) => {
  const scroller = scrollerOf(view.dom)
  if (!scroller) {
    done()
    return () => {}
  }
  const target = (): number | null => {
    const now = scroll()
    if (!now) return null
    const line = view.lineBlockAt(Math.min(now.at, view.state.doc.length))
    const off = line.top + now.into * line.height - heightAtTop(view, scroller)
    return Math.min(
      Math.max(0, scroller.scrollTop + off / scaleOf(view)),
      scroller.scrollHeight - scroller.clientHeight,
    )
  }
  // Where it last put the pane: a scroll anywhere else is someone else's.
  let placed = scroller.scrollTop
  // Whether it moved.
  const go = (): boolean => {
    const top = target()
    if (top === null || Math.abs(top - scroller.scrollTop) < 1) return false
    scroller.scrollTo({ top, behavior: "instant" })
    placed = scroller.scrollTop
    return true
  }
  const stop = new AbortController()
  const { signal } = stop
  let frame = 0
  const finish = (): void => {
    if (signal.aborted) return
    stop.abort()
    cancelAnimationFrame(frame)
    done()
  }
  for (const type of ["wheel", "touchstart", "pointerdown", "keydown"])
    scroller.addEventListener(type, finish, { signal, passive: true })
  // Scrolled by anyone else, as the app jumping somewhere or the page keeping what shows
  // in place, the pane stays where they put it.
  scroller.addEventListener(
    "scroll",
    () => {
      const top = scroller.scrollTop
      // The pane cut short as what it holds shrank for a moment isn't anyone's scroll.
      const clamped = top < placed && top >= scroller.scrollHeight - scroller.clientHeight - 1
      if (!clamped && Math.abs(top - placed) >= 1) finish()
    },
    { signal, passive: true },
  )
  // What the place depends on in the layout: the zoom, and the heights the editor holds,
  // which it estimates again as the zoom changes and corrects once it has measured.
  const layoutOf = (): string =>
    `${scaleOf(view).toFixed(3)}|${view.contentHeight.toFixed(1)}|${scroller.scrollHeight}|${scroller.clientHeight}`
  // The editor may still correct heights it estimated a while on, as it measures again
  // after a resize settles: it holds still once neither the pane nor the layout changed for
  // 150ms and eight frames, or after half a second and twenty frames, and at the latest
  // after three seconds. Times are the frames' own, so a busy page's long frames count.
  let began = -1
  let moved = 0
  let frames = 0
  let still = 0
  let layout = ""
  const settle = (now: number): void => {
    if (began < 0) began = moved = now
    frames += 1
    const moving = go()
    const seen = layoutOf()
    const changed = seen !== layout
    layout = seen
    if (moving || changed) {
      moved = now
      still = 0
    } else still += 1
    const held = now - moved >= 150 && still >= 8
    const late = (now - began >= 500 && frames >= 20) || now - began >= 3000
    if (held || late) finish()
    else frame = requestAnimationFrame(settle)
  }
  const start = (): void => {
    placed = scroller.scrollTop
    go()
    layout = layoutOf()
    frame = requestAnimationFrame(settle)
  }
  if (scroller.clientHeight) start()
  else {
    const shows = new ResizeObserver(() => {
      if (!scroller.clientHeight) return
      shows.disconnect()
      start()
    })
    shows.observe(scroller)
    signal.addEventListener("abort", () => shows.disconnect())
  }
  return finish
}
