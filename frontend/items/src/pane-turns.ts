import { useShown } from "@novadeck/toolkit/shown"
import { createContext, useContext, useEffect, useState } from "react"

// Companion panes build in turns. What a pane shows can cost a lot to build (a diff, a plan's
// editor, a page's view), and a view that brings many into sight at once (Grid or Canvas
// opening, a pan) would build them all in one frame; Focus would build the pane in the same
// frame as the terminal it switched to. So a pane coming into sight stands in for what it
// shows until its turn, one pane a frame, after the frame that showed its window: the
// window draws first, and each pane after it.
//
// A pane built once keeps what it shows while out of sight; coming back into sight, it is
// laid out again in its turn, not in the frame that shows it.
export type PaneTurns = {
  // Asks a turn for a pane, the selected terminal's ahead of the rest; `granted` runs once
  // it comes. Returns the cancel.
  readonly want: (first: boolean, granted: () => void) => () => void
}

// Outside the workspace (a single pane, a test of one) nothing competes: every turn is now.
const now: PaneTurns = {
  want: (_first, granted) => {
    granted()
    return () => {}
  },
}

export const PaneTurnsContext = createContext<PaneTurns>(now)

// When the next turn may come: after the coming frame has drawn. The browser can hold
// frames back for a while as a view switches, so a turn comes after `lateMs` without one.
export type Pace = (next: () => void) => () => void

/** How long a turn waits for a frame before it comes anyway. */
export const lateMs = 100

const afterFrame: Pace = (next) => {
  // Where there are no frames, as in a test's document, the late timer alone paces.
  const frames = typeof requestAnimationFrame === "function"
  let done = false
  const go = (): void => {
    if (done) return
    done = true
    if (frames) cancelAnimationFrame(frame)
    clearTimeout(late)
    // The frame has started: the turn runs once it's drawn, as a task of its own.
    setTimeout(next, 0)
  }
  const frame = frames ? requestAnimationFrame(go) : 0
  const late = setTimeout(go, lateMs)
  return () => {
    done = true
    if (frames) cancelAnimationFrame(frame)
    clearTimeout(late)
  }
}

// The demo's debug panel holds every turn while the page's root carries this, so a pane's
// stand-in can be looked at.
export const heldAttribute = "data-pane-turns-held"

const held = (): boolean =>
  typeof document !== "undefined" && document.documentElement.hasAttribute(heldAttribute)

export const createPaneTurns = (pace: Pace = afterFrame): PaneTurns => {
  // Waiting, in the order they asked: the first of the selected ones goes next, else the
  // first of them all.
  const waiting: { readonly first: boolean; readonly granted: () => void }[] = []
  // The pace under way, if any: a turn of one stopped meanwhile, whose frame or timer had
  // already passed, does nothing.
  let pacing: { readonly stop: () => void } | undefined
  const schedule = (): void => {
    if (pacing !== undefined || !waiting.length) return
    const current = { stop: (): void => {} }
    pacing = current
    const stop = pace(() => {
      if (pacing !== current) return
      pacing = undefined
      turn()
    })
    current.stop = stop
  }
  const turn = (): void => {
    if (!held()) {
      const selected = waiting.findIndex((each) => each.first)
      waiting.splice(Math.max(selected, 0), 1)[0]?.granted()
    }
    schedule()
  }
  return {
    want: (first, granted) => {
      const entry = { first, granted }
      waiting.push(entry)
      schedule()
      return () => {
        const at = waiting.indexOf(entry)
        if (at >= 0) waiting.splice(at, 1)
        if (waiting.length || !pacing) return
        pacing.stop()
        pacing = undefined
      }
    },
  }
}

export type PaneTurn = {
  // What the pane shows has been built: once its first turn came, for as long as it's there.
  readonly built: boolean
  // It stands in for what it shows: not built yet, or come back into sight and waiting its
  // turn to be laid out again. Going out of sight doesn't hide what it shows, which leaves
  // as it was, as Focus fades a terminal out.
  readonly waiting: boolean
}

// The turn of the pane this is called in, while it's in sight (see `Shown`) and `wanted`,
// showing something; `first` for the selected terminal's.
export const usePaneTurn = (first: boolean, wanted = true): PaneTurn => {
  const turns = useContext(PaneTurnsContext)
  const shown = useShown()
  // Whether it was built, and whether its turn came since it last came into sight.
  const [state, setState] = useState({ built: false, ready: false })
  if (!shown && state.ready) setState({ built: true, ready: false })
  const waits = turns !== now && wanted && shown && !state.ready
  // Asked again as its terminal is selected or no longer is, taking its new place.
  useEffect(() => {
    if (!waits) return
    let live = true
    const cancel = turns.want(first, () => {
      if (live) setState({ built: true, ready: true })
    })
    return () => {
      live = false
      cancel()
    }
  }, [turns, waits, first])
  // Nothing to wait for: built and laid out at once.
  if (turns === now) return { built: true, waiting: false }
  return { built: state.built, waiting: !state.built || (shown && !state.ready) }
}
