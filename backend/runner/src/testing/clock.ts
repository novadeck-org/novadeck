import { vi } from "vitest"

import type { Resources } from "./resources.js"

type Faked = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]>[number]

// How far `restore` moves the fake clock on, in milliseconds, before the real one is back:
// past every wait a close or shutdown sets, as a kill escalation's second and settling's five.
// A timer that sets itself again forever, as the doorbell's, runs a few times and is dropped.
const drainMs = 60_000

/**
 * Fakes `toFake` (vitest's default timers without it) on the global clock until `restore`,
 * or until the test's resources are disposed, should the test end first, as one that times
 * out does. Restoring first runs what the timers set meanwhile, and those they set, have due
 * within `drainMs`: a timer set on the fake clock never fires on the real one, so what waits
 * on it, as a close's kill escalation, would wait forever. Disposal restores it in turn,
 * like any cleanup: what the test created before faking it is disposed on the real clock.
 */
export const fakeClock = (resources: Resources, toFake?: readonly Faked[]) => {
  vi.useFakeTimers(toFake && { toFake: [...toFake] })
  let restored: Promise<void> | undefined
  const restore = () =>
    (restored ??= (async () => {
      // A test that put the real clock back itself, as an `afterEach` may, has nothing to run.
      if (!vi.isFakeTimers()) return
      try {
        await vi.advanceTimersByTimeAsync(drainMs)
      } finally {
        vi.useRealTimers()
      }
    })())
  resources.defer(restore, "restoring the real clock")
  return { restore }
}
