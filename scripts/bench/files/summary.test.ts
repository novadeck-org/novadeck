import { describe, expect, it } from "vitest"

import { defaults } from "./scenario.ts"
import { markdown, percentile, summarize, type Report, type Sample } from "./summary.ts"

const sample = (wallMs: number, extra: Partial<Sample> = {}): Sample => ({
  wallMs,
  busyMs: wallMs,
  scriptMs: wallMs / 2,
  layoutMs: 1,
  styleMs: 1,
  longTasks: [],
  commits: 3,
  reactMs: 10,
  reads: 0,
  rows: 3300,
  ...extra,
})

describe("a percentile", () => {
  it("is the nearest-rank value, whatever the samples' order", () => {
    const values = [50, 10, 40, 20, 30, 100, 60, 70, 80, 90]

    expect(percentile(values, 0.5)).toBe(50)
    expect(percentile(values, 0.95)).toBe(100)
  })

  it("is null with no samples", () => {
    expect(percentile([], 0.5)).toBeNull()
  })
})

describe("a run's summary", () => {
  it("takes the median and p95 of each figure over the polls", () => {
    const summary = summarize([100, 200, 300, 400, 500].map((wall) => sample(wall)))

    expect(summary.count).toBe(5)
    expect(summary.wallMs).toEqual({ median: 300, p95: 500 })
    expect(summary.commits).toEqual({ median: 3, p95: 3 })
  })

  it("counts the long tasks over every poll and keeps the longest", () => {
    const summary = summarize([
      sample(100, { longTasks: [60, 80] }),
      sample(100, { longTasks: [55] }),
    ])

    expect(summary.longTasks).toEqual({ count: 3, totalMs: 195, maxMs: 80 })
  })

  it("has no figures where nothing was measured", () => {
    const summary = summarize([])

    expect(summary.wallMs.median).toBeNull()
    expect(summary.rows).toBeNull()
  })
})

describe("a run's markdown", () => {
  const report = (turns: readonly Sample[]): Report => ({
    version: 1,
    label: "main",
    startedAt: "2026-11-19T00:00:00.000Z",
    commit: "0123456789abcdef",
    environment: {
      cpus: 4,
      cpu: "test cpu",
      chromium: "1.0",
      loadBefore: 1,
      loadAfter: 2,
      idleBusyMs: 50,
    },
    config: defaults,
    polls: [sample(100)],
    turns,
    summary: {
      polls: summarize([sample(100)]),
      turns: turns.length > 0 ? summarize(turns) : null,
    },
  })

  it("has a row for the polls, and one for the turn ends where there were any", () => {
    expect(markdown(report([]))).not.toContain("| turn end |")
    expect(markdown(report([sample(40)]))).toContain("| turn end | 40.0 / 40.0 |")
  })

  it("leads with the label and the commit", () => {
    expect(markdown(report([])).split("\n")[0]).toBe("# Files panel bench: main")
    expect(markdown(report([]))).toContain("Commit 012345678")
  })
})
