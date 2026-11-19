// How the Files tree moves when keeping an agent filters it, or letting go brings the rest back:
// the rows that stay slide from where they were to where they are, the rows that go fade where
// they were, and the rows that come fade in. Planned on screen positions (a line's top less the
// scroll), so a scroll the browser clamps as the tree shrinks moves nothing by itself. Only what
// is on screen before or after moves, and a row from far off starts just past the edge, so a
// long tree costs what a screen of it does.

import { rowHeight } from "./files-window"

// The tree as one frame drew it: where it was scrolled, every line's place by its key, and the
// keys of the lines drawn.
export type Frame = {
  readonly scrollTop: number
  readonly lineOf: ReadonlyMap<string, number>
  readonly drawn: readonly string[]
}

export type Plan = {
  // Rows drawn now that start `from` px off their place and slide into it.
  readonly moves: readonly { readonly key: string; readonly from: number }[]
  // Rows drawn now that were nowhere before, which fade in.
  readonly entering: readonly string[]
  // Rows drawn before that are not now: drawn `top` px down the view, where they were on screen,
  // then faded out there, or slid `shift` px to their place off screen.
  readonly leaving: readonly {
    readonly key: string
    readonly top: number
    readonly shift: number | undefined
  }[]
}

const onScreen = (top: number, viewport: number): boolean => top > -rowHeight && top < viewport

// A row from far off starts, or a row going far off ends, a row past the edge.
const nearEdge = (top: number, viewport: number): number =>
  Math.min(viewport, Math.max(-rowHeight, top))

export const planMotion = (before: Frame, after: Frame, viewport: number): Plan => {
  const screen = (frame: Frame, key: string): number | undefined => {
    const line = frame.lineOf.get(key)
    return line === undefined ? undefined : line * rowHeight - frame.scrollTop
  }
  const drawnNow = new Set(after.drawn)
  const moves: { key: string; from: number }[] = []
  const entering: string[] = []
  for (const key of after.drawn) {
    const now = screen(after, key)!
    const was = screen(before, key)
    if (was === undefined) {
      if (onScreen(now, viewport)) entering.push(key)
      continue
    }
    if (!onScreen(now, viewport) && !onScreen(was, viewport)) continue
    const from = nearEdge(was, viewport) - now
    if (from !== 0) moves.push({ key, from })
  }
  const leaving: { key: string; top: number; shift: number | undefined }[] = []
  for (const key of before.drawn) {
    if (drawnNow.has(key)) continue
    const was = screen(before, key)!
    if (!onScreen(was, viewport)) continue
    const now = screen(after, key)
    leaving.push({
      key,
      top: was,
      shift: now === undefined ? undefined : nearEdge(now, viewport) - was,
    })
  }
  return { moves, entering, leaving }
}
