import { describe, expect, it } from "vitest"

import {
  markdown,
  compared,
  pageNumbers,
  summarize,
  throttledPhases,
  triggers,
  type PhaseResult,
  type RunResult,
} from "./summary.ts"
import type { Breakdown } from "./trace.ts"

// Shares of a 15 s window: 1% is 150 ms.
const part = (share: number) => ({ ms: share * 150, share })

const breakdown = (busy: number, tracks?: number): Breakdown => ({
  windowMs: 15_000,
  mainThread: {
    ...part(busy),
    scripting: {
      ...part(busy / 2),
      reactRender: part(busy / 4),
      reactCommit: part(busy / 8),
      xtermParsing: part(busy / 16),
      xtermRendering: part(0),
      store: part(busy / 8),
      transport: part(busy / 16),
      garbageCollection: part(0),
      otherScript: part(0),
    },
    styleLayout: part(busy / 4),
    paintComposite: part(busy / 8),
    other: part(busy / 8),
  },
  selfBySource: {
    react: part(busy / 10),
    xtermParser: part(0),
    xtermRenderer: part(0),
    xterm: part(0),
    protocol: part(0),
    packages: part(0),
    app: part(busy / 2 - busy / 10),
    unmapped: part(0),
    garbageCollection: part(0),
  },
  sampled: {
    reactRender: 0,
    reactCommit: 0,
    xtermParsing: 0,
    xtermRendering: 0,
    store: 0,
    transport: 0,
    garbageCollection: 0,
    otherScript: 0,
    bySource: {
      react: 0,
      xtermParser: 0,
      xtermRenderer: 0,
      xterm: 0,
      protocol: 0,
      packages: 0,
      app: 0,
      unmapped: 0,
      garbageCollection: 0,
    },
    samples: 0,
    intervalUs: 0,
  },
  ...(tracks !== undefined && { reactTracks: { render: part(tracks), commit: part(0) } }),
  threads: { Compositor: part(3) },
  compositorFps: 60,
  otherNames: [],
})

const phase = (
  name: PhaseResult["phase"],
  busy: number,
  extra: Partial<PhaseResult> = {},
): PhaseResult => ({
  phase: name,
  trace: `traces/${name}.json.gz`,
  breakdown: breakdown(busy),
  fps: 60 - busy / 10,
  frames: 100,
  framesOver33ms: busy,
  longTasks: 0,
  switches: [],
  visible: true,
  focused: true,
  ...extra,
})

const run = (
  scenario: RunResult["scenario"],
  index: number,
  phases: PhaseResult[],
  extra: Partial<RunResult> = {},
): RunResult => ({
  scenario,
  variant: "production",
  run: index,
  agentPhases: [],
  attributed: true,
  phases,
  problems: [],
  ...extra,
})

describe("pageNumbers", () => {
  it("gives frames a second over the gaps' time, and the gaps over 33 ms", () => {
    expect(pageNumbers([16, 16, 50, 18], [60, 70])).toEqual({
      fps: 40,
      frames: 4,
      framesOver33ms: 1,
      longTasks: 2,
    })
    expect(pageNumbers([], [])).toEqual({ fps: 0, frames: 0, framesOver33ms: 0, longTasks: 0 })
  })
})

describe("summarize", () => {
  it("gives each scenario's phases' numbers as their median and range across runs", () => {
    const summary = summarize([
      run("timing", 1, [phase("grid", 40)]),
      run("timing", 2, [phase("grid", 80)]),
      run("timing", 3, [phase("grid", 60)]),
      run("heavy", 1, [phase("grid", 90)]),
    ])
    const grid = summary.production?.timing?.phases.grid
    expect(grid?.mainThread).toEqual({ median: 60, min: 40, max: 80, values: [40, 80, 60] })
    expect(grid?.reactRender?.median).toBe(15)
    expect(grid?.compositorThread?.median).toBe(3)
    // React's render and commit are 3/8 of busy, its own frames a tenth; with the stores'
    // eighth, state propagation is half.
    expect(grid?.reactOfBusy?.median).toBe(37.5)
    expect(grid?.statePropagationOfBusy?.median).toBe(50)
    expect(grid?.reactSelfOfBusy?.median).toBe(10)
    expect(grid?.reactTracksOfBusy).toBeUndefined()
    expect(summary.production?.heavy?.phases.grid?.mainThread?.values).toEqual([90])
    // A grid phase has no switches.
    expect(grid?.switchP50Ms).toBeUndefined()
    expect(grid?.switchesTimedOut).toBeUndefined()
  })

  it("leaves out a run's numbers its trace couldn't give, and counts switches that timed out", () => {
    const { breakdown: _, ...unread } = phase("switches", 0, {
      switches: [
        { target: 1, ms: 30 },
        { target: 2, ms: undefined },
        { target: 3, ms: 50 },
      ],
    })
    const summary = summarize([
      run("timing", 1, [{ ...unread, traceError: "no marks" }]),
      run("timing", 2, [phase("switches", 20)]),
    ])
    const switches = summary.production?.timing?.phases.switches
    expect(switches?.mainThread?.values).toEqual([20])
    expect(switches?.fps?.values).toEqual([60, 58])
    expect(switches?.switchP50Ms?.values).toEqual([30])
    expect(switches?.switchesTimedOut?.values).toEqual([1, 0])
  })

  it("keeps each build apart, and compares the others with the production build", () => {
    const summary = summarize([
      run("heavy", 1, [phase("grid", 40)]),
      run("heavy", 1, [{ ...phase("grid", 50), breakdown: breakdown(50, 10) }], {
        variant: "profiling",
      }),
      run("heavy", 1, [phase("grid", 30)], { variant: "webgl" }),
    ])
    expect(summary.production?.heavy?.phases.grid?.mainThread?.values).toEqual([40])
    expect(summary.profiling?.heavy?.phases.grid?.reactTracksOfBusy?.values).toEqual([20])
    expect(compared(summary, "profiling")).toEqual({
      heavy: { grid: { production: 40, variant: 50, points: 10 } },
    })
    expect(compared(summary, "webgl")).toEqual({
      heavy: { grid: { production: 40, variant: 30, points: -10 } },
    })
    // WebGL's cut, a quarter of Grid's busy time, and of each of its 100 frames.
    expect(markdown(summary, { title: "Profile", lines: [] })).toContain(
      "| 40.0% | 30.0% | 25.0% | 25.0% |",
    )
    expect(compared(summary, "webgl", "busyMsPerFrame").heavy?.grid).toEqual({
      production: 60,
      variant: 45,
      points: -15,
    })
  })

  it("leaves out the script's split where the build couldn't be mapped, and marks saturation", () => {
    const summary = summarize([
      run("heavy", 1, [phase("grid", 99)], { attributed: false }),
      run("heavy", 1, [phase("grid", 96)], { variant: "webgl" }),
    ])
    const grid = summary.production?.heavy?.phases.grid
    expect(grid?.mainThread?.values).toEqual([99])
    expect(grid?.reactOfBusy).toBeUndefined()
    expect(summary.production?.heavy?.triggers.statePropagationOfBusy).toBeUndefined()
    expect(markdown(summary, { title: "Profile", lines: [] })).toContain("(saturated)")
  })
})

describe("throttled phases", () => {
  it("leave their numbers out, and their run out of the triggers", () => {
    const runs = [
      run("heavy", 1, [phase("grid", 80), phase("focus", 20)]),
      run("heavy", 2, [
        phase("grid", 40),
        {
          ...phase("focus", 2),
          fps: 1,
          breakdown: { ...breakdown(2), compositorFps: 1 },
        },
      ]),
      // Slow but drawing: a main thread too busy for its own frames, the compositor still
      // drawing, isn't throttled.
      run("heavy", 3, [{ ...phase("grid", 99), fps: 0, frames: 0 }, phase("focus", 30)]),
    ]
    const summary = summarize(runs).production?.heavy
    // The second run's Grid counts, its Focus doesn't.
    expect(summary?.phases.grid?.mainThread?.values).toEqual([80, 40, 99])
    expect(summary?.phases.focus?.mainThread?.values).toEqual([20, 30])
    expect(summary?.triggers.transportOfBusy?.values).toHaveLength(2)
    expect(throttledPhases(runs)).toEqual(["heavy, production, run 2: focus"])
    // Without a trace, the page's own frames tell.
    const { breakdown: _, ...untraced } = { ...phase("grid", 0), fps: 1 }
    expect(throttledPhases([run("heavy", 4, [untraced])])).toEqual([
      "heavy, production, run 4: grid",
    ])
  })
})

describe("the triggers", () => {
  it("count only runs that have every phase, each read", () => {
    const unread = (name: PhaseResult["phase"]): PhaseResult => {
      const { breakdown: _, ...rest } = phase(name, 20)
      return { ...rest, traceError: "too long" }
    }
    const runs = [
      run("heavy", 1, [phase("grid", 80), phase("focus", 20)]),
      // Failed after Grid, the busiest phase, which alone would read high.
      run("heavy", 2, [phase("grid", 80)], { error: "the app closed" }),
      run("heavy", 3, [phase("grid", 80), unread("focus")]),
    ]
    expect(summarize(runs).production?.heavy?.triggers.transportOfBusy?.values).toEqual([6.25])
    // Their phases still count in the tables.
    expect(summarize(runs).production?.heavy?.phases.grid?.mainThread?.values).toEqual([80, 80, 80])
  })
})

describe("triggers", () => {
  it("reads a run's phases together, as shares of their busy time", () => {
    const one = run("heavy", 1, [phase("grid", 80), phase("focus", 20)])
    // The transport is a sixteenth of every phase's busy time, so of both together.
    expect(triggers.transportOfBusy(one)).toBe(6.25)
    expect(triggers.reactOfBusy(one)).toBe(37.5)
    expect(triggers.statePropagationOfBusy(one)).toBe(50)
    expect(triggers.storeSpansOfBusy(one)).toBeUndefined()
    expect(triggers.reactTracksOfBusy(one)).toBeUndefined()
    expect(summarize([one]).production?.heavy?.triggers.transportOfBusy?.median).toBe(6.25)
  })
})

describe("markdown", () => {
  it("shows the triggers, then a table a scenario and build, with the median and the range", () => {
    const text = markdown(
      summarize([run("timing", 1, [phase("grid", 40)]), run("timing", 2, [phase("grid", 80)])]),
      { title: "Profile", lines: ["On a machine."] },
    )
    expect(text).toContain("# Profile\n\nOn a machine.\n")
    expect(text).toContain(
      "| timing | 50.0% (50.0%–50.0%) | 37.5% (37.5%–37.5%) | 10.0% (10.0%–10.0%) | – | – |",
    )
    expect(text).toContain("## timing, production build\n\n| | grid |\n|---|---|\n")
    // Two runs' median is the mean of the two.
    expect(text).toContain("| Main thread busy | 60.0% (40.0%–80.0%) |")
    expect(text).toContain("| Frames over 33 ms | 60 (40–80) |")
    expect(text).not.toContain("Switch p50")
    expect(text).not.toContain("profiling build's overhead")
  })
})
