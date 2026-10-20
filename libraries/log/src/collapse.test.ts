import { describe, expect, it } from "vitest"

import { collapse, drain, due, type Repeats } from "./collapse.js"
import type { Entry, Level } from "./envelope.js"

const at = (ms: number): string => new Date(ms).toISOString()

const line = (ms: number, msg: string, level: Level = "info"): Entry => ({
  v: 1,
  t: at(ms),
  level,
  proc: "runner",
  sid: "s",
  pid: 1,
  src: "doorbell",
  evt: "doorbell.hold",
  msg,
})

/** Feeds lines through, at their times, and gathers what is written. */
const run = (lines: readonly [number, Entry][], windowMs = 1_000) => {
  let repeats: Repeats = new Map()
  const written: Entry[] = []
  for (const [now, entry] of lines) {
    const result = collapse(repeats, entry, now, windowMs)
    repeats = result.repeats
    written.push(...result.write)
  }
  return { repeats, written }
}

describe("collapse", () => {
  it("writes a line the first time and holds back its repeats", () => {
    const { written } = run([
      [0, line(0, "held")],
      [100, line(100, "held")],
      [200, line(200, "held")],
    ])
    expect(written.map((entry) => entry.msg)).toEqual(["held"])
  })

  it("says how often a line came again once its window is over", () => {
    const { written } = run([
      [0, line(0, "held")],
      [100, line(100, "held")],
      [200, line(200, "held")],
      [1_500, line(1_500, "other")],
    ])
    expect(written.map((entry) => [entry.evt, entry.msg])).toEqual([
      ["doorbell.hold", "held"],
      ["log.repeated", "held (repeated 2 more times)"],
      ["doorbell.hold", "other"],
    ])
    expect(written[1]?.data).toEqual({ evt: "doorbell.hold", count: 2, since: at(0) })
    expect(written[1]?.t).toBe(at(200))
  })

  it("writes a line again once its window is over", () => {
    const { written } = run([
      [0, line(0, "held")],
      [1_200, line(1_200, "held")],
    ])
    expect(written.map((entry) => entry.msg)).toEqual(["held", "held"])
  })

  it("tells lines apart by their data", () => {
    const { written } = run([
      [0, { ...line(0, "held"), data: { terminal: "a" } }],
      [10, { ...line(10, "held"), data: { terminal: "b" } }],
    ])
    expect(written).toHaveLength(2)
  })

  it("always writes a fatal line", () => {
    const { written } = run([
      [0, line(0, "gone", "fatal")],
      [10, line(10, "gone", "fatal")],
    ])
    expect(written).toHaveLength(2)
  })

  it("writes everything when the window is 0", () => {
    const { written } = run(
      [
        [0, line(0, "held")],
        [0, line(0, "held")],
      ],
      0,
    )
    expect(written).toHaveLength(2)
  })
})

describe("due", () => {
  it("counts out the repeats whose window is over, with nothing new logged", () => {
    const { repeats } = run([
      [0, line(0, "held")],
      [100, line(100, "held")],
    ])
    expect(due(repeats, 500, 1_000).write).toEqual([])
    const later = due(repeats, 1_000, 1_000)
    expect(later.write.map((entry) => entry.msg)).toEqual(["held (repeated 1 more time)"])
    expect(later.repeats.size).toBe(0)
  })
})

describe("drain", () => {
  it("counts out every repeat still held", () => {
    const { repeats } = run([
      [0, line(0, "held")],
      [100, line(100, "held")],
      [200, line(200, "once")],
    ])
    expect(drain(repeats).map((entry) => entry.msg)).toEqual(["held (repeated 1 more time)"])
  })
})
