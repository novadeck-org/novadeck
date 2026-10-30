import type { Log } from "@novadeck/log"

/** How long the runner goes without a beat before it logs the main process as stalled, in ms. */
export const mainStallMs = 3_000

/**
 * Watches the app's main process from the runner, which lives on when the main thread
 * hangs: a window that froze before the app died then shows in runner.log whether the
 * main process itself stopped, and for how long. The main process beats every `mainBeatMs`
 * (../bridge.ts); `check` runs on the runner's own timer.
 */
export const watchMainProcess = (options: {
  readonly log: Log
  readonly now: () => number
  /** How often `check` runs, so a check that ran late tells of the runner's own stall. */
  readonly checkMs: number
  readonly stallMs?: number
}) => {
  const { log, now, checkMs, stallMs = mainStallMs } = options
  // Not watched until the first beat: a main process still starting hasn't begun beating.
  let lastBeat: number | undefined
  let lastCheck: number | undefined
  let stalled = false
  // Numbers each stall, so the log never folds a second one into the first as a repeat.
  let stalls = 0
  return {
    beat(): void {
      const at = now()
      if (stalled && lastBeat !== undefined)
        log.info("host.answered", "The main process answers again.", {
          data: { stall: stalls, stalledMs: Math.round(at - lastBeat) },
        })
      stalled = false
      lastBeat = at
    },
    check(): void {
      const at = now()
      const gap = lastCheck === undefined ? 0 : at - lastCheck
      lastCheck = at
      if (lastBeat === undefined || stalled) return
      // The runner was held up itself, or the computer slept: its own lateness is no sign
      // of the main process, while the time it had already gone quiet still counts.
      if (gap > 2 * checkMs) lastBeat = Math.min(at, lastBeat + gap - checkMs)
      if (at - lastBeat < stallMs) return
      stalled = true
      stalls += 1
      log.warn("host.stalled", "The main process stopped answering.", {
        data: { stall: stalls, sinceMs: Math.round(at - lastBeat) },
      })
    },
  }
}
