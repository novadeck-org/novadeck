import type { DragDropManager } from "@dnd-kit/abstract"
import { effect, untracked } from "@dnd-kit/state"

// Runs `then` once the drag that just ended has settled: its drop animation has played out and
// the manager has let go of its source. dnd-kit tells `dragend` as the drag is let go, before
// it animates the row into its place. A list that renders its rows again right then (in a new
// order, or mounted anew) takes the element out from under that animation, which then plays
// on the new element from the old one's place and size: the row is gone until it ends. So a
// list saves its order and remounts its rows here. Returns a function that stops waiting.
export const afterDrop = (manager: DragDropManager<any, any>, then: () => void): (() => void) => {
  let done = false
  let stop: (() => void) | undefined = undefined
  stop = effect(() => {
    if (done || !manager.dragOperation.status.idle) return
    done = true
    // Within the effect, at its first run, `stop` isn't there yet; it stops just below.
    stop?.()
    untracked(then)
  })
  if (done) stop()
  return () => {
    done = true
    stop?.()
  }
}
