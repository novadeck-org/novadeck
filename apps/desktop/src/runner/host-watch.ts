import type { Log } from "@novadeck/log"

/** How long the runner goes without a beat before it logs the host as stalled, in ms. */
export const hostStallMs = 3_000

/**
 * Watches the host's main process from the runner, which lives on when the host's main
 * thread hangs: a window that froze before the app died then shows in runner.log whether
 * the host itself stopped, and for how long. The host beats every `hostBeatMs` (../bridge.ts); `check`
 * runs on the runner's own timer.
 */
export const watchHost = (options: {
  readonly log: Log
  readonly now: () => number
  /** How often `check` runs, so a check that ran late tells of the runner's own stall. */
  readonly checkMs: number
  readonly stallMs?: number
}) => {
  const { log, now, checkMs, stallMs = hostStallMs } = options
  // Not watched until the first beat: a host still starting hasn't begun beating.
  let lastBeat: number | undefined
  let lastCheck: number | undefined
  let stalled = false
  return {
    beat(): void {
      const at = now()
      if (stalled && lastBeat !== undefined)
        log.info("host.answered", "The host's main process answers again.", {
          data: { stalledMs: Math.round(at - lastBeat) },
        })
      stalled = false
      lastBeat = at
    },
    check(): void {
      const at = now()
      const late = lastCheck !== undefined && at - lastCheck > 2 * checkMs
      lastCheck = at
      if (lastBeat === undefined || stalled) return
      // The runner was the one held up, or the computer slept: the host's beats wait in
      // the queue, so the gap is no sign of the host.
      if (late) {
        lastBeat = at
        return
      }
      if (at - lastBeat < stallMs) return
      stalled = true
      log.warn("host.stalled", "The host's main process stopped answering.", {
        data: { sinceMs: Math.round(at - lastBeat) },
      })
    },
  }
}
