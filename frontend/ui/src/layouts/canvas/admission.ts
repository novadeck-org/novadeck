// How many windows that come into sight together take their screen in one animation frame. A
// terminal's first screen (DOM rows, glyph measuring, a fit) costs tens of milliseconds, so
// two keep a frame to a short stall where ten at once make a visible hitch; one or two
// nodes panned into view still arrive in the next frame.
export const perFrame = 2

export type Frames = {
  readonly request: (callback: () => void) => number
  readonly cancel: (handle: number) => void
}

const browserFrames: Frames = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle),
}

// Which of the nodes in sight may take their screen. The selected node is admitted at once;
// the others wait their turn, a few per frame, nearest the middle of the view first.
export type Admission = {
  // Whether the node has been admitted; false for one waiting or unknown.
  readonly admitted: (id: string) => boolean
  // A node came into sight, `distance` from the middle of the view.
  readonly want: (id: string, distance: number) => void
  // A node left the sight or the canvas: it gives up its turn and its admission.
  readonly drop: (id: string) => void
  // The node admitted at once, in place of waiting; undefined for none.
  readonly select: (id: string | undefined) => void
}

export const createAdmission = (
  onAdmit: (ids: readonly string[]) => void,
  frames: Frames = browserFrames,
): Admission => {
  const admitted = new Set<string>()
  const waiting = new Map<string, number>()
  let selected: string | undefined
  let frame: number | undefined
  const stopFrame = (): void => {
    if (frame !== undefined) frames.cancel(frame)
    frame = undefined
  }
  const schedule = (): void => {
    if (frame === undefined && waiting.size) frame = frames.request(tick)
  }
  const tick = (): void => {
    frame = undefined
    const turn = [...waiting].toSorted((a, b) => a[1] - b[1]).slice(0, perFrame)
    for (const [id] of turn) {
      waiting.delete(id)
      admitted.add(id)
    }
    schedule()
    if (turn.length) onAdmit(turn.map(([id]) => id))
  }
  const admitNow = (id: string): boolean => {
    if (admitted.has(id)) return false
    waiting.delete(id)
    admitted.add(id)
    if (!waiting.size) stopFrame()
    return true
  }
  return {
    admitted: (id) => admitted.has(id),
    want: (id, distance) => {
      if (admitted.has(id)) return
      if (id === selected) {
        admitNow(id)
        onAdmit([id])
        return
      }
      waiting.set(id, distance)
      schedule()
    },
    drop: (id) => {
      admitted.delete(id)
      waiting.delete(id)
      if (!waiting.size) stopFrame()
    },
    select: (id) => {
      selected = id
      if (id !== undefined && waiting.has(id) && admitNow(id)) onAdmit([id])
    },
  }
}
