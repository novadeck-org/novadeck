import type { Log } from "@novadeck/log"

/** How long the runner goes without a beat before it logs the host as stalled, in ms. */
export const hostStallMs = 3_000

/**
 * Watches the host's main process from the runner, which lives on when the host's main
 * thread hangs: a window that froze before the app died then shows in runner.log whether
 * the host itself stopped, and for how long. The host beats every `hostBeatMs`
 * (../bridge.ts); `check` runs on the runner's own timer.
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
  // Numbers each stall, so the log never folds a second one into the first as a repeat.
  let stalls = 0
  return {
    beat(): void {
      const at = now()
      if (stalled && lastBeat !== undefined)
        log.info("host.answered", "The host's main process answers again.", {
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
      // of the host, while the time the host had already gone quiet still counts.
      if (gap > 2 * checkMs) lastBeat = Math.min(at, lastBeat + gap - checkMs)
      if (at - lastBeat < stallMs) return
      stalled = true
      stalls += 1
      log.warn("host.stalled", "The host's main process stopped answering.", {
        data: { stall: stalls, sinceMs: Math.round(at - lastBeat) },
      })
    },
  }
}
