import { act } from "react"
import { vi } from "vitest"

// The counter run's clock. Timers, animation frames, Date and performance are fake, so
// time moves only when the script moves it: the park timer, xterm's writes (a timer) and
// its paints (an animation frame) land on the same frame every run. React works inside
// `act`, which renders and runs effects as each frame's `act` ends instead of whenever the
// browser schedules it. What the browser still does in real time, as a ResizeObserver
// reporting a new size, follows a frame that changed the page: the frame then awaits real
// frames, each in an `act` of its own, until one changes nothing, so what they set off
// falls in that frame too.

export const frameMs = 16
// The epoch the clock starts at, so dates read the same every run.
const start = new Date("2026-01-01T00:00:00Z")

export type Clock = {
  // Moves the clock `count` frames, letting everything due in each run.
  readonly frames: (count: number) => Promise<void>
  // Moves the clock a frame at a time until `work` settles, as many frames as it takes,
  // failing after `most`.
  readonly until: <T>(work: Promise<T>, most?: number) => Promise<T>
  // Does something as one step: what it changes renders and paints over `frames` frames.
  readonly step: (action: () => unknown, frames?: number) => Promise<void>
  readonly stop: () => void
}

// A real task's turn, for promise chains that cross one, without waiting for a frame.
const nextTask = () =>
  new Promise<void>((resolve) => {
    const { port1, port2 } = new MessageChannel()
    port1.addEventListener("message", () => resolve(), { once: true })
    port1.start()
    port2.postMessage(undefined)
  })

// How many real frames a frame awaits at most for the page to stop changing.
const realFramesAtMost = 8

// `changes` is a count that moves whenever the page may have changed, as React commits and
// DOM mutations do.
export const startClock = (changes: () => number): Clock => {
  const realFrame = window.requestAnimationFrame.bind(window)
  const nextRealFrame = () => new Promise<void>((resolve) => realFrame(() => resolve()))
  const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  // Rendering helpers turn React's act environment off after their own `act`; each of
  // these turns it on again.
  const inAct = (work: () => Promise<void>) => {
    environment.IS_REACT_ACT_ENVIRONMENT = true
    return act(work)
  }
  vi.useFakeTimers({
    now: start,
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "Date",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "requestIdleCallback",
      "cancelIdleCallback",
      "performance",
    ],
  })
  // Real frames, while the page keeps changing since `seen`.
  const settle = async (seen: number): Promise<void> => {
    for (let round = 0; changes() !== seen; round += 1) {
      // A page that never settles would spill into the frames after: fail rather than count.
      if (round === realFramesAtMost)
        throw new Error(`The page still changed after ${realFramesAtMost} real frames`)
      seen = changes()
      // eslint-disable-next-line no-await-in-loop -- One real frame after another.
      await inAct(nextRealFrame)
    }
  }
  // One frame: the fake clock's timers and animation frames due in it, inside one `act`,
  // with a real task's turn for promise chains that cross one; then real frames if it
  // changed the page.
  const frame = async (): Promise<void> => {
    const seen = changes()
    await inAct(async () => {
      vi.advanceTimersByTime(frameMs)
      await nextTask()
    })
    await settle(seen)
  }
  const frames = async (count: number): Promise<void> => {
    // eslint-disable-next-line no-await-in-loop -- Frames run one after another.
    for (let index = 0; index < count; index += 1) await frame()
  }
  return {
    frames,
    until: async (work, most = 200) => {
      let settled = false
      const done = work.finally(() => {
        settled = true
      })
      // Its failure is reported once, where it is awaited below.
      done.catch(() => {})
      const waiting = (): boolean => !settled
      // eslint-disable-next-line no-await-in-loop -- Frames run one after another.
      for (let index = 0; index < most && waiting(); index += 1) await frame()
      if (waiting()) throw new Error(`Still waiting after ${most} frames`)
      return done
    },
    step: async (action, count = 2) => {
      const seen = changes()
      await inAct(async () => {
        await action()
        await nextTask()
      })
      await settle(seen)
      await frames(count)
    },
    stop: () => {
      vi.useRealTimers()
      environment.IS_REACT_ACT_ENVIRONMENT = false
    },
  }
}
