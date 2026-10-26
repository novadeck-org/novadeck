import type { Detail, Log } from "@novadeck/log"

import { context, describe, expect, it } from "../test"
import { watchHost } from "./host-watch"

/** A watcher on a clock the test moves, and the lines it logged. */
const watched = () => {
  let time = 0
  const lines: { level: string; evt: string; data: unknown }[] = []
  const line = (level: string) => (evt: string, _msg?: string, detail?: Detail) =>
    lines.push({ level, evt, data: detail?.data })
  const log: Log = {
    debug: line("debug"),
    info: line("info"),
    warn: line("warn"),
    error: line("error"),
    fatal: line("fatal"),
  }
  const watch = watchHost({ log, now: () => time, checkMs: 500, stallMs: 3_000 })
  // Checks every 500 ms up to `until`, beating every `beatMs` (never when undefined).
  const run = (until: number, beatMs?: number) => {
    while (time < until) {
      time += 500
      if (beatMs !== undefined && time % beatMs === 0) watch.beat()
      watch.check()
    }
  }
  const skip = (ms: number) => {
    time += ms
  }
  return { watch, lines, run, skip }
}

describe("watchHost", () => {
  context("when the host beats on time", () => {
    it("logs nothing", () => {
      const { lines, run } = watched()
      run(20_000, 1_000)
      expect(lines).toEqual([])
    })
  })

  context("before the host's first beat", () => {
    it("logs nothing however long it waits", () => {
      const { lines, run } = watched()
      run(20_000)
      expect(lines).toEqual([])
    })
  })

  context("when the host's beats stop", () => {
    it("logs one stall once they are three seconds late", () => {
      const { lines, run } = watched()
      run(1_000, 1_000)
      run(10_000)
      expect(lines).toEqual([{ level: "warn", evt: "host.stalled", data: { sinceMs: 3_000 } }])
    })

    it("logs how long it stalled when the host beats again", () => {
      const { watch, lines, run } = watched()
      run(1_000, 1_000)
      run(9_000)
      watch.beat()
      expect(lines.at(-1)).toEqual({
        level: "info",
        evt: "host.answered",
        data: { stalledMs: 8_000 },
      })
    })

    it("watches again after the host answers", () => {
      const { watch, lines, run } = watched()
      run(1_000, 1_000)
      run(5_000)
      watch.beat()
      run(10_000)
      expect(lines.map(({ evt }) => evt)).toEqual(["host.stalled", "host.answered", "host.stalled"])
    })
  })

  context("when the runner itself was held up", () => {
    it("doesn't blame the host for the beats waiting in its queue", () => {
      const { watch, lines, run, skip } = watched()
      run(2_000, 1_000)
      skip(30_000)
      watch.check()
      watch.beat()
      run(40_000, 1_000)
      expect(lines).toEqual([])
    })
  })
})
