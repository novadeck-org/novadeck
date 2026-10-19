import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks"

import { onTestFailed, onTestFinished } from "vitest"

// Keep cold-render failures useful without adding success-log noise or changing their
// deadlines. Wall time beside worker CPU and loop delay distinguishes work from waiting.
export const testPhases = (name: string, snapshot?: () => unknown): ((phase: string) => void) => {
  const began = performance.now()
  const cpu = process.cpuUsage()
  const loop = monitorEventLoopDelay({ resolution: 20 })
  let gcMs = 0
  const gc = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) gcMs += entry.duration
  })
  gc.observe({ entryTypes: ["gc"] })
  loop.enable()
  const phases: unknown[] = []
  const mark = (phase: string): void => {
    const used = process.cpuUsage(cpu)
    phases.push({
      phase,
      elapsedMs: Math.round(performance.now() - began),
      cpuMs: Math.round((used.user + used.system) / 1000),
      rssMb: Math.round(process.memoryUsage().rss / 1024 ** 2),
      loopMaxMs: Math.round(loop.max / 1e6),
      gcMs: Math.round(gcMs),
    })
  }
  mark("start")
  onTestFailed(() => {
    mark("failure")
    console.error("UI_TEST_PHASES", JSON.stringify({ name, phases, snapshot: snapshot?.() }))
  })
  onTestFinished(() => {
    loop.disable()
    gc.disconnect()
  })
  return mark
}
