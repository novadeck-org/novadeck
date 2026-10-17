import { describe, expect, it } from "vitest"

import { breakdown, storeSpan, type Attribution, type Frame, type TraceEvent } from "./trace.ts"

const main = { pid: 10, tid: 11 }
const at = (ts: number) => ts * 1000

const complete = (name: string, start: number, ms: number, where = main): TraceEvent => ({
  name,
  ph: "X",
  ts: at(start),
  dur: at(ms),
  ...where,
})

const marks = (from: number, to: number): TraceEvent[] => [
  { name: "profile-start", ph: "I", ts: at(from), ...main },
  { name: "profile-end", ph: "I", ts: at(to), ...main },
]

const named = (pid: number, tid: number, name: string): TraceEvent => ({
  name: "thread_name",
  ph: "M",
  pid,
  tid,
  ts: 0,
  args: { name },
})

const none: Attribution = { kind: () => undefined, group: () => "unmapped" }

describe("breakdown", () => {
  it("gives each event's self time to its kind, or to its nearest named ancestor's", () => {
    const result = breakdown(
      [
        ...marks(0, 100),
        complete("ThreadControllerImpl::RunTask", 10, 40),
        complete("FunctionCall", 12, 20),
        complete("V8.Execute", 13, 10),
        complete("Layout", 35, 5),
        complete("ThreadControllerImpl::RunTask", 60, 10),
        complete("Paint", 61, 4),
        complete("V8.GC_MC_INCREMENTAL", 66, 2),
      ],
      none,
    )
    expect(result.windowMs).toBe(100)
    expect(result.mainThread.ms).toBe(50)
    expect(result.mainThread.share).toBe(50)
    // FunctionCall's 20 ms, V8.Execute inside it included, and V8's GC.
    expect(result.mainThread.scripting.ms).toBe(22)
    expect(result.mainThread.styleLayout.ms).toBe(5)
    expect(result.mainThread.paintComposite.ms).toBe(4)
    expect(result.mainThread.other.ms).toBe(19)
    expect(result.otherNames).toEqual([{ name: "ThreadControllerImpl::RunTask", ms: 19 }])
  })

  it("clips events to the window, and pairs begin and end events", () => {
    const result = breakdown(
      [
        ...marks(10, 20),
        complete("Layout", 5, 10),
        { name: "UpdateLayoutTree", ph: "B", ts: at(16), ...main },
        { name: "UpdateLayoutTree", ph: "E", ts: at(30), ...main },
      ],
      none,
    )
    expect(result.mainThread.styleLayout.ms).toBe(9)
    expect(result.mainThread.ms).toBe(9)
  })

  it("leaves out other threads' events, and fails without both marks", () => {
    const result = breakdown(
      [...marks(0, 10), complete("Layout", 1, 5, { pid: 10, tid: 99 })],
      none,
    )
    expect(result.mainThread.ms).toBe(0)
    expect(() => breakdown([complete("Layout", 1, 5)], none)).toThrow(/marks/)
  })

  it("splits scripting by the samples' nearest classified frame", () => {
    const frame = (functionName: string, url?: string): Frame =>
      url === undefined ? { functionName } : { functionName, url }
    const nodes = [
      { id: 1, callFrame: frame("(root)") },
      { id: 2, parent: 1, callFrame: frame("performWorkOnRoot", "app.js") },
      { id: 3, parent: 2, callFrame: frame("renderRootSync", "react") },
      { id: 4, parent: 3, callFrame: frame("write", "xterm") },
      { id: 5, parent: 1, callFrame: frame("(garbage collector)") },
      { id: 6, parent: 1, callFrame: frame("(idle)") },
      { id: 7, parent: 2, callFrame: frame("commitRoot", "react-commit") },
    ]
    const attribution: Attribution = {
      kind: (each) =>
        each.url === "react"
          ? "reactRender"
          : each.url === "react-commit"
            ? "reactCommit"
            : each.url === "xterm"
              ? "xtermParsing"
              : undefined,
      group: (each) =>
        each.url === "react" || each.url === "react-commit"
          ? "react"
          : each.url === "xterm"
            ? "xterm"
            : "app",
    }
    const result = breakdown(
      [
        ...marks(0, 100),
        complete("FunctionCall", 0, 50),
        { name: "Profile", ph: "P", id: "0x1", ts: 0, args: { data: { startTime: 0 } }, ...main },
        {
          name: "ProfileChunk",
          ph: "P",
          id: "0x1",
          ts: 0,
          pid: main.pid,
          tid: 12,
          // A sample every 10 ms from 0, each lasting until the next: render three times,
          // xterm, commit, GC, idle and other script twice; the last has no next.
          args: {
            data: {
              cpuProfile: { nodes, samples: [3, 3, 3, 4, 7, 5, 6, 2, 2, 2] },
              timeDeltas: [0, ...Array.from({ length: 9 }, () => at(10))],
            },
          },
        },
      ],
      attribution,
    )
    expect(result.sampled).toMatchObject({
      reactRender: 30,
      xtermParsing: 10,
      reactCommit: 10,
      garbageCollection: 10,
      otherScript: 20,
      samples: 9,
      intervalUs: 10_000,
    })
    const { scripting } = result.mainThread
    expect(scripting.ms).toBe(50)
    // Scripting's 50 ms by the sampled script's 80.
    expect(scripting.reactRender.ms).toBe(18.75)
    expect(scripting.reactCommit.ms).toBe(6.25)
    expect(scripting.xtermParsing.ms).toBe(6.25)
    expect(scripting.garbageCollection.ms).toBe(6.25)
    expect(scripting.otherScript.ms).toBe(12.5)
    // Bottom up, each sample goes to its own frame's part: performWorkOnRoot is the app's.
    expect(result.sampled.bySource).toMatchObject({
      react: 40,
      xterm: 10,
      app: 20,
      garbageCollection: 10,
    })
    expect(result.selfBySource.react.ms).toBe(25)
    expect(result.reactTracks).toBeUndefined()
  })

  it("counts samples in the order they were taken, as V8 writes some deltas negative", () => {
    const frame = (functionName: string, url?: string): Frame =>
      url === undefined ? { functionName } : { functionName, url }
    const result = breakdown(
      [
        ...marks(0, 100),
        complete("FunctionCall", 0, 30),
        { name: "Profile", ph: "P", id: "0x1", ts: 0, args: { data: { startTime: 0 } }, ...main },
        {
          name: "ProfileChunk",
          ph: "P",
          id: "0x1",
          ts: 0,
          pid: main.pid,
          tid: 12,
          // Taken at 0, 20, 10 and 30: idle, other script, React render, idle.
          args: {
            data: {
              cpuProfile: {
                nodes: [
                  { id: 1, callFrame: frame("(root)") },
                  { id: 2, parent: 1, callFrame: frame("(idle)") },
                  { id: 3, parent: 1, callFrame: frame("own", "app") },
                  { id: 4, parent: 1, callFrame: frame("renderRootSync", "react") },
                ],
                samples: [2, 3, 4, 2],
              },
              timeDeltas: [0, at(20), at(-10), at(20)],
            },
          },
        },
      ],
      {
        kind: (each) => (each.url === "react" ? "reactRender" : undefined),
        group: () => "app",
      },
    )
    expect(result.sampled).toMatchObject({ reactRender: 10, otherScript: 10, samples: 3 })
  })

  it("reads React's tracks: its render and commit entries, overlaps once, clipped", () => {
    const entry = (message: string, start: number, end: number, trackGroup = "Scheduler ⚛") => ({
      name: "TimeStamp",
      ph: "I",
      ts: at(end),
      ...main,
      args: { data: { message, start: at(start), end: at(end), trackGroup } },
    })
    const result = breakdown(
      [
        ...marks(10, 100),
        entry("Render", 0, 20),
        entry("Render", 15, 30),
        entry("Interrupted Render", 40, 45),
        entry("Commit", 30, 34),
        entry("Remaining Effects", 34, 36),
        entry("Waiting for Paint", 36, 50),
        entry("App", 0, 90, "Components ⚛"),
      ],
      none,
    )
    expect(result.reactTracks?.render.ms).toBe(25)
    expect(result.reactTracks?.render.share).toBeCloseTo(25 / 0.9)
    expect(result.reactTracks?.commit.ms).toBe(6)
  })

  it("reads the store listener spans, as async pairs or complete events, clipped", () => {
    const span = (ph: string, ts: number, id: string, dur?: number): TraceEvent => ({
      name: storeSpan,
      cat: "blink.user_timing",
      ph,
      ts: at(ts),
      ...(dur !== undefined && { dur: at(dur) }),
      id,
      pid: main.pid,
      tid: 99,
    })
    const result = breakdown(
      [
        ...marks(10, 100),
        span("b", 5, "0x1"),
        span("b", 30, "0x2"),
        span("e", 15, "0x1"),
        span("e", 34, "0x2"),
        span("X", 50, "0x3", 3),
      ],
      none,
    )
    expect(result.storeSpans?.ms).toBe(12)
    expect(breakdown(marks(0, 10), none).storeSpans).toBeUndefined()
  })

  it("counts the drawing threads' busy time and the compositor's frames", () => {
    const compositor = { pid: 10, tid: 12 }
    const viz = { pid: 20, tid: 21 }
    const result = breakdown(
      [
        ...marks(0, 1000),
        named(10, 12, "Compositor"),
        named(20, 21, "VizCompositorThread"),
        named(30, 31, "VizCompositorThread"),
        named(10, 13, "ThreadPoolForegroundWorker"),
        { name: "process_name", ph: "M", pid: 20, tid: 0, ts: 0, args: { name: "GPU Process" } },
        complete("A", 0, 100, compositor),
        complete("B", 50, 100, compositor),
        complete("C", 0, 10, viz),
        // A pool worker's task, and the raster tasks in it.
        complete("ThreadPool_RunTask", 0, 400, { pid: 10, tid: 13 }),
        complete("RasterTask", 0, 200, { pid: 10, tid: 13 }),
        complete("RasterTask", 250, 100, { pid: 10, tid: 13 }),
        // Another renderer's, left out.
        complete("D", 0, 500, { pid: 30, tid: 31 }),
        ...[100, 200, 300].map((ms) => ({ name: "DrawFrame", ph: "I", ts: at(ms), ...compositor })),
      ],
      none,
    )
    // The compositor by its own thread; raster by its tasks alone, on the thread they run on.
    expect(result.threads.Compositor).toEqual({ ms: 150, share: 15 })
    expect(result.threads.raster).toEqual({ ms: 300, share: 30 })
    expect(result.threads.VizCompositorThread).toEqual({ ms: 10, share: 1 })
    expect(result.compositorFps).toBe(3)
    // A trace that names no compositor thread tells nothing of its frames.
    expect(breakdown(marks(0, 1000), none).compositorFps).toBeUndefined()
    // A phase with no raster task had none: 0, not unknown.
    expect(breakdown(marks(0, 1000), none).threads.raster).toEqual({ ms: 0, share: 0 })
  })
})
