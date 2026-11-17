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
          inView: [1, 2],
          longTasks: [60, 70],
        },
      ],
      switches: [],
    })

    expect(summary.framesFrom).toBe("trace")
    expect(summary.steady).toEqual([
      {
        layout: "Grid",
        mainThreadShare: 25,
        fps: 3,
        framesOver33ms: 2,
        inView: [1, 2],
        longTasks: 2,
      },
    ])
  })
})

describe("a scenario that didn't hold", () => {
  const painted = { target: 1, ms: 30 }
  const lost = { target: 2, ms: undefined }
  const running = ["running", "running", "running", "running", "running"]
  const grid = (inView: number[]) => ({ layout: "Grid", inView })
  const focus = (inView: number[]) => ({ layout: "Focus", inView })

  it("is none when every agent runs, the windows show them and the switches paint", () => {
    const switches = [painted, painted]
    const windows = [grid([1, 2, 3, 4]), focus([1])]
    expect(scenarioFailures({ agentPhases: running, switches, windows }, 5)).toEqual([])
  })

  it("names the agents that never ran", () => {
    const [failure] = scenarioFailures({ agentPhases: ["running", "idle", null], switches: [] }, 3)
    expect(failure).toContain("1 of 3 agents were running")
    expect(failure).toContain("running, idle, null")
  })

  it("names a Grid that shows idle shells, whatever the agents' phases", () => {
    const windows = [grid([10, 11, 12, 13]), focus([1])]
    const failures = scenarioFailures({ agentPhases: running, switches: [], windows }, 5)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Grid showed ["T10","T11","T12","T13"]')
    expect(failures[0]).toContain("at least 4 agents")
  })

  it("wants fewer agents in Grid where there are fewer", () => {
    const windows = [grid([1, 2, 3, 9]), focus([1])]
    expect(
      scenarioFailures(
        { agentPhases: ["running", "running", "running"], switches: [], windows },
        3,
      ),
    ).toEqual([])
  })

  it("names a Focus that doesn't show agent 1", () => {
    const windows = [grid([1, 2, 3, 4]), focus([13])]
    const [failure] = scenarioFailures({ agentPhases: running, switches: [], windows }, 5)
    expect(failure).toContain('Focus showed ["T13"]')
  })

  it("names switches that painted for fewer than nine in ten", () => {
    const eleven = [
      painted,
      painted,
      painted,
      painted,
      painted,
      painted,
      painted,
      painted,
      painted,
      painted,
    ]
    const one = scenarioFailures({ agentPhases: running, switches: [...eleven, lost] }, 5)
    expect(one).toEqual([])
    const two = scenarioFailures({ agentPhases: running, switches: [...eleven, lost, lost] }, 5)
    expect(two).toEqual(["the scenario didn't hold: 2 of 12 switches never painted"])
  })
})
