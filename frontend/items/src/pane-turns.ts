import { useShown } from "@novadeck/toolkit/shown"
import { createContext, useContext, useEffect, useRef, useState } from "react"

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
  let stop: (() => void) | undefined
  const schedule = (): void => {
    if (stop === undefined && waiting.length) stop = pace(turn)
  }
  const turn = (): void => {
    stop = undefined
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
        if (!waiting.length) {
          stop?.()
          stop = undefined
        }
      }
    },
  }
}

export type PaneTurn = {
  // What the pane shows has been built: once its first turn came, for as long as it's there.
  readonly built: boolean
  // It may be laid out and drawn: its turn came since it last came into sight.
  readonly ready: boolean
}

// The turn of the pane this is called in, while it's in sight (see `Shown`); `first` for the
// selected terminal's.
export const usePaneTurn = (first: boolean): PaneTurn => {
  const turns = useContext(PaneTurnsContext)
  const shown = useShown()
  const [state, setState] = useState<PaneTurn>({ built: false, ready: false })
  // Out of sight, it waits for a turn again before it's laid out.
  if (!shown && state.ready) setState({ built: true, ready: false })
  const priority = useRef(first)
  useEffect(() => {
    priority.current = first
  })
  const waits = turns !== now && shown && !state.ready
  useEffect(() => {
    if (!waits) return
    let live = true
    const cancel = turns.want(priority.current, () => {
      if (live) setState({ built: true, ready: true })
    })
    return () => {
      live = false
      cancel()
    }
  }, [turns, waits])
  // Nothing to wait for: built and laid out at once.
  return turns === now ? { built: true, ready: true } : state
}
