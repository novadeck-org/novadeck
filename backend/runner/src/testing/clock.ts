import { vi } from "vitest"

import type { Resources } from "./resources.js"

type Faked = NonNullable<NonNullable<Parameters<typeof vi.useFakeTimers>[0]>["toFake"]>[number]

// How many rounds of timers `restore` runs at most, each those the round before scheduled:
// enough for a loop that looks every 100 ms through a five-second window, as settling does.
const drainRounds = 100

/**
 * Fakes `toFake` (vitest's default timers without it) on the global clock until `restore`,
 * or until the test's resources are disposed, should the test end first, as one that times
 * out does. Restoring runs the timers set meanwhile, and those they set, before the real
 * clock is back: a timer set on the fake clock never fires on the real one, so what waits on
 * it, as a close's kill escalation, would wait forever. Fake the clock after creating what
 * the test disposes, so it is restored first.
 */
export const fakeClock = (resources: Resources, toFake?: readonly Faked[]) => {
  vi.useFakeTimers(toFake && { toFake: [...toFake] })
  let restored: Promise<void> | undefined
  const restore = () =>
    (restored ??= (async () => {
      try {
        for (let round = 0; round < drainRounds && vi.getTimerCount() > 0; round += 1)
          // eslint-disable-next-line no-await-in-loop -- Each round runs what the one before set.
          await vi.runOnlyPendingTimersAsync()
      } finally {
        vi.useRealTimers()
      }
    })())
  resources.defer(restore, "restoring the real clock")
  return { restore }
}
