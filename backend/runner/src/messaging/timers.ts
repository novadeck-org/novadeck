/** How often, and after how long, messaging's timers fire; each takes 0 to never run. */
export type TimerOptions = {
  readonly sweepMs?: number
  readonly restoreMs?: number
  readonly waitsMs?: number
}

/** What the timers do when they fire. */
export type Ticks = {
  readonly sweep: () => void
  readonly restored: () => void
  readonly waits: () => void
}

/**
 * Sweeps old messages once, then starts messaging's timers (their sweep, the end of the restore window, the look for
 * long waits), none of which keeps the process alive. Returns what stops them.
 */
export const startTimers = (options: TimerOptions, ticks: Ticks): (() => void) => {
  ticks.sweep()
  const timers: (ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>)[] = []
  if (options.sweepMs !== 0) timers.push(setInterval(ticks.sweep, options.sweepMs ?? 60 * 60_000))
  if (options.restoreMs !== 0) timers.push(setTimeout(ticks.restored, options.restoreMs ?? 120_000))
  if (options.waitsMs !== 0) timers.push(setInterval(ticks.waits, options.waitsMs ?? 60_000))
  for (const timer of timers) timer.unref()
  return () => {
    for (const timer of timers) {
      clearInterval(timer)
      clearTimeout(timer)
    }
  }
}
