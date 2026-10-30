import type { EditorView } from "@codemirror/view"

// How far below the top of the scroller a line lands.
const margin = 24

// The nearest ancestor that scrolls on its own, never one that only clips.
const scrollerOf = (element: HTMLElement): HTMLElement | null => {
  for (let at = element.parentElement; at; at = at.parentElement)
    if (/^(auto|scroll)$/.test(getComputedStyle(at).overflowY)) return at
  return null
}

// Brings the line at `at` to the top of the scroller, smoothly unless motion is reduced.
// Only the scroller moves: CodeMirror's scrollIntoView also scrolls every
// ancestor whose content overflows, clipped ones included, which shifts the whole page.
// Lines out of view have estimated heights, so once the scroll stops, or a frame after an
// instant one, it corrects for where the line really is, unless the person took over the
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

// Where the scroller is scrolled in the text: the line at its top, and how far down that line,
// as a share of its height, which holds across a narrower or zoomed scroller.
export type Scroll = { readonly at: number; readonly into: number }

// How far the scroller's top is into the document, in the page's pixels, which CodeMirror
// measures its lines in: scaled where an app zooms it, or while it scales in.
const heightAtTop = (view: EditorView, scroller: HTMLElement): number =>
  scroller.getBoundingClientRect().top - view.documentTop

// How many page pixels a pixel of the scroller's own scroll is. Over the whole editor, so
// rounding its height to whole pixels hardly matters.
const scaleOf = (view: EditorView): number => {
  const tall = view.dom.offsetHeight
  return tall ? view.dom.getBoundingClientRect().height / tall : 1
}

// Whether CodeMirror's lines are still measured at another zoom than the one showing, as
// a pane scales in on a page too busy to draw the frame that measures it: its heights are
// then the old zoom's, and a place worked out from them lands somewhere else.
const behindOnZoom = (view: EditorView): boolean => Math.abs(view.scaleY - scaleOf(view)) > 0.01

// Follows where the scroller is scrolled in the text, while it's on screen; returns the stop.
export const followScroll = (view: EditorView, on: (scroll: Scroll) => void): (() => void) => {
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

export type ScrollRestore = { readonly stop: () => void; readonly layout: () => void }

// Keeps the saved line through layout changes until the person scrolls or an app jumps
// elsewhere. Frames settle the editor's estimated heights, then sleep; a resize or a
// CodeMirror geometry update wakes them again, even after a late font load or Canvas fit.
// `done` hands ownership to the scroll follower only when the restore is stopped.
export const restoreScroll = (
  view: EditorView,
  scroll: () => Scroll | null,
  done: () => void,
): ScrollRestore => {
  const scroller = scrollerOf(view.dom)
  if (!scroller) {
    done()
    return { stop: () => {}, layout: () => {} }
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
  // Where it last put the scroller: a scroll anywhere else is someone else's.
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
  // Scrolled by anyone else, as an app jumping somewhere or the page keeping what shows
  // in place, the scroller stays where they put it.
  scroller.addEventListener(
    "scroll",
    () => {
      const top = scroller.scrollTop
      // The scroller cut short as what it holds shrank for a moment isn't anyone's scroll.
      const clamped = top < placed && top >= scroller.scrollHeight - scroller.clientHeight - 1
      if (!clamped && Math.abs(top - placed) >= 1) {
        // Layout and the browser's scroll anchoring can move the scroller without input.
        if (layoutOf() !== layout) resume()
        else finish()
      }
    },
    { signal, passive: true },
  )
  // What the place depends on in the layout: the zoom, and the heights the editor holds,
  // which it estimates again as the zoom changes and corrects once it has measured.
  const layoutOf = (): string =>
    `${scaleOf(view).toFixed(3)}|${view.contentHeight.toFixed(1)}|${scroller.scrollHeight}|${scroller.clientHeight}`
  // The editor may still correct heights it estimated a while on, as it measures again
  // after a resize settles: it holds still once neither the scroller nor the layout changed for
  // 150ms and eight frames, or after half a second and twenty frames, and at the latest
  // after three seconds. Times are the frames' own, so a busy page's long frames count.
  let began = -1
  let moved = 0
  let frames = 0
  let still = 0
  let layout = ""
  const settle = (now: number): void => {
    frame = 0
    if (!scroller.clientHeight) return
    if (began < 0) {
      began = moved = now
      placed = scroller.scrollTop
    }
    frames += 1
    // Not worked out, nor counted as settled, until the editor has measured at this zoom.
    const behind = behindOnZoom(view)
    if (behind) view.requestMeasure()
    const moving = !behind && go()
    const seen = layoutOf()
    const changed = seen !== layout
    layout = seen
    if (moving || changed || behind) {
      moved = now
      still = 0
    } else still += 1
    const held = now - moved >= 150 && still >= 8
    const late = (!behind && now - began >= 500 && frames >= 20) || now - began >= 3000
    // Out of time with the editor still behind: the best place its measure gives, rather than
    // the text's top.
    if (late && behind) go()
    if (!held && !late) frame = requestAnimationFrame(settle)
  }
  const resume = (): void => {
    if (signal.aborted || frame) return
    began = -1
    frames = still = 0
    // Called from CodeMirror's update listener too, where reading layout is forbidden.
    frame = requestAnimationFrame(settle)
  }
  const resize = new ResizeObserver(resume)
  resize.observe(scroller)
  resize.observe(view.dom)
  signal.addEventListener("abort", () => resize.disconnect())
  resume()
  return { stop: finish, layout: resume }
}
