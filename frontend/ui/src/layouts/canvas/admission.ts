// How many windows that come into sight together take their screen in one batch. A
// terminal's first screen (DOM rows, glyph measuring, a fit) costs about 7 ms, so two keep a
// batch to a short stall where ten at once make a visible hitch; one or two nodes panned
// into view arrive in a single batch.
export const perBatch = 2

// Batches are paced by yielding to the event loop, not by animation frames: during a view
// switch the browser can withhold frames for hundreds of milliseconds, and a frame-paced
// queue would wait out each one for a few milliseconds of work. Input and frames still run
// between batches whenever the browser is ready.
export type Yield = {
  readonly request: (callback: () => void) => number
  readonly cancel: (handle: number) => void
}

// A message to ourselves runs as its own task, and unlike a timer is neither clamped to 4 ms
// when nested nor throttled in the background. Where there are no channels, a timer does.
const channelYield = (): Yield => {
  const { port1, port2 } = new MessageChannel()
  const pending = new Map<number, () => void>()
  let next = 0
  port1.addEventListener("message", ({ data }: MessageEvent<number>) => {
    const callback = pending.get(data)
    pending.delete(data)
    callback?.()
  })
  port1.start()
  return {
    request: (callback) => {
      pending.set(next, callback)
      port2.postMessage(next)
      return next++
    },
    cancel: (handle) => void pending.delete(handle),
  }
}

const timerYield: Yield = {
  request: (callback) => window.setTimeout(callback, 0),
  cancel: (handle) => window.clearTimeout(handle),
}

let shared: Yield | undefined
const browserYield: Yield = {
  request: (callback) =>
    (shared ??= typeof MessageChannel === "undefined" ? timerYield : channelYield()).request(
      callback,
    ),
  cancel: (handle) => shared?.cancel(handle),
}

// Which of the nodes in sight may take their screen. The selected node is admitted at once;
// the others wait their turn, a batch at a time, nearest the middle of the view first.
type Admission = {
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
  yields: Yield = browserYield,
): Admission => {
  const admitted = new Set<string>()
  const waiting = new Map<string, number>()
  let selected: string | undefined
  let continuation: number | undefined
  const stopWaiting = (): void => {
    if (continuation !== undefined) yields.cancel(continuation)
    continuation = undefined
  }
  const schedule = (): void => {
    if (continuation === undefined && waiting.size) continuation = yields.request(tick)
  }
  const tick = (): void => {
    continuation = undefined
    const turn = [...waiting].toSorted((a, b) => a[1] - b[1]).slice(0, perBatch)
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
    if (!waiting.size) stopWaiting()
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
      if (!waiting.size) stopWaiting()
    },
    select: (id) => {
      selected = id
      if (id !== undefined && waiting.has(id) && admitNow(id)) onAdmit([id])
    },
  }
}
