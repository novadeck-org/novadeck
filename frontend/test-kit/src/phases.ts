import { monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks"

import { onTestFinished } from "vitest"

// Taken as the module loads: a test's fake timers fake the global one, and a faked one would
// never run while they last.
const realSetImmediate = setImmediate

// Where a test was when it reached a phase: since its start, and the worker's state then.
type Phase = {
  readonly phase: string
  readonly elapsedMs: number
  readonly cpuMs: number
  readonly rssMb: number
  readonly loopMaxMs: number
  readonly gcMs: number
}

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
  const phases: Phase[] = []
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
  // Vitest runs a test's onTestFinished before its onTestFailed, so the failure is noted
  // here, while the loop and GC are still watched. Node records a collection a macrotask
  // after it, so that runs first, and the entries not yet delivered are taken. The row comes
  // after the test's afterEach hooks and the onTestFinished hooks registered after this one
  // (such as `render`'s unmount), so their time counts too.
  onTestFinished(async ({ task }) => {
    try {
      await new Promise((resolve) => realSetImmediate(resolve))
      for (const entry of gc.takeRecords()) gcMs += entry.duration
      if (task.result?.state === "fail") {
        mark("failure")
        console.error("UI_TEST_PHASES", JSON.stringify({ name, phases, snapshot: snapshot?.() }))
      }
    } finally {
      loop.disable()
      gc.disconnect()
    }
  })
  return mark
}
