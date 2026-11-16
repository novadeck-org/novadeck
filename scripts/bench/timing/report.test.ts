import { describe, expect, it } from "vitest"

import { percentile, scenarioFailures, summarize } from "./report.ts"

describe("a percentile", () => {
  it("is the nearest-rank value, whatever the samples' order", () => {
    const values = [50, 10, 40, 20, 30, 100, 60, 70, 80, 90]

    expect(percentile(values, 0.9)).toBe(90)
    expect(percentile(values, 0.5)).toBe(50)
    expect(percentile(values, 1)).toBe(100)
  })

  it("is null with no samples", () => {
    expect(percentile([], 0.9)).toBeNull()
  })
})

describe("a run's summary", () => {
  it("takes the switch percentiles over the switches that painted, counting the rest", () => {
    const summary = summarize({
      agentPhases: [],
      steady: [],
      switches: [
        { target: 1, ms: 30 },
        { target: 2, ms: 40 },
        { target: 3, ms: undefined },
      ],
    })

    expect(summary.switchP90Ms).toBe(40)
    expect(summary.switchP50Ms).toBe(30)
    expect(summary.switchesTimedOut).toBe(1)
  })

  it("has no switch percentiles where none painted", () => {
    expect(
      summarize({ agentPhases: [], steady: [], switches: [{ target: 1, ms: undefined }] })
        .switchP90Ms,
    ).toBeNull()
  })

  it("counts the agents the runner heard", () => {
    expect(
      summarize({ agentPhases: ["running", "unheard", null, "running"], steady: [], switches: [] })
        .agentsHeard,
    ).toBe(2)
  })

  it("gives each steady window its main-thread share, frame rate and slow frames", () => {
    const summary = summarize({
      agentPhases: [],
      steady: [
        {
          layout: "Grid",
          seconds: 2,
          taskSeconds: 0.5,
          frames: 6,
          slowFrames: 2,
          longTasks: [60, 70],
        },
      ],
      switches: [],
    })

    expect(summary.framesFrom).toBe("trace")
    expect(summary.steady).toEqual([
      { layout: "Grid", mainThreadShare: 25, fps: 3, framesOver33ms: 2, longTasks: 2 },
    ])
  })
})

describe("a scenario that didn't hold", () => {
  const painted = { target: 1, ms: 30 }
  const lost = { target: 2, ms: undefined }

  it("is none when every agent runs and most switches paint", () => {
    const agentPhases = ["running", "running"]
    expect(scenarioFailures({ agentPhases, switches: [painted, painted, lost] }, 2)).toEqual([])
  })

  it("names the agents that never ran", () => {
    const [failure] = scenarioFailures({ agentPhases: ["running", "idle", null], switches: [] }, 3)
    expect(failure).toContain("1 of 3 agents were running")
    expect(failure).toContain("running, idle, null")
  })

  it("names switches that mostly never painted", () => {
    const failures = scenarioFailures(
      { agentPhases: ["running"], switches: [painted, lost, lost] },
      1,
    )
    expect(failures).toEqual(["the scenario didn't hold: 2 of 3 switches never painted"])
  })
})
