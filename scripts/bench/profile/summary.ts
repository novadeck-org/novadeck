import { percentile, type Switch } from "../timing/report.ts"
import type { PhaseName, ScenarioName } from "./drive.ts"
import type { Breakdown } from "./trace.ts"

// The profile's numbers: each phase's, from its trace and what the page recorded, each run's
// over all its phases, as the plan's triggers read them, and their spread across runs, as
// the JSON keeps them and the markdown shows them.

/**
 * The app's build a run ran: the package's own, one with React DOM's profiling build, or one
 * whose screens draw with xterm's WebGL renderer.
 */
export type Variant = "production" | "profiling" | "webgl"

/** One phase of one run. */
export type PhaseResult = {
  readonly phase: PhaseName
  /** The trace, relative to the output folder. */
  readonly trace: string
  readonly breakdown?: Breakdown
  /** Why the trace couldn't be read, should it not be. */
  readonly traceError?: string
  /** Frames a second the page's animation frames ran at, and their gaps over 33 ms. */
  readonly fps: number
  /** The page's animation frames over the window. */
  readonly frames: number
  readonly framesOver33ms: number
  readonly longTasks: number
  readonly switches: readonly Switch[]
  readonly visible: boolean
  readonly focused: boolean
}

export type RunResult = {
  readonly scenario: ScenarioName
  readonly variant: Variant
  readonly run: number
  readonly agentPhases: readonly (string | null)[]
  /** Whether the build's source maps split its script; no split's numbers count otherwise. */
  readonly attributed: boolean
  readonly phases: readonly PhaseResult[]
  readonly problems: readonly string[]
  readonly error?: string
}

/** A number's spread across runs. */
export type Spread = {
  readonly median: number
  readonly min: number
  readonly max: number
  readonly values: readonly number[]
}

/** The middle value, or the mean of the middle two. */
const median = (values: readonly number[]): number => {
  const sorted = values.toSorted((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2
}

const spread = (values: readonly number[]): Spread | undefined =>
  values.length === 0
    ? undefined
    : {
        median: median(values),
        min: Math.min(...values),
        max: Math.max(...values),
        values,
      }

/** `part` of the main thread's busy time, in percent. */
const ofBusy = (part: number | undefined, busy: number | undefined) =>
  part === undefined || !busy ? undefined : (part / busy) * 100

const reactMs = (one: Breakdown) =>
  one.mainThread.scripting.reactRender.ms + one.mainThread.scripting.reactCommit.ms

// State propagation: the stores' dispatch, listeners and selectors, and the render and
// commit they cause.
const propagationMs = (one: Breakdown) => reactMs(one) + one.mainThread.scripting.store.ms

const tracksMs = (one: Breakdown) =>
  one.reactTracks && one.reactTracks.render.ms + one.reactTracks.commit.ms

/** The numbers each phase gives, by name: shares in percent of the window unless named "of busy". */
export const metrics = {
  mainThread: (one: PhaseResult) => one.breakdown?.mainThread.share,
  scripting: (one: PhaseResult) => one.breakdown?.mainThread.scripting.share,
  reactRender: (one: PhaseResult) => one.breakdown?.mainThread.scripting.reactRender.share,
  reactCommit: (one: PhaseResult) => one.breakdown?.mainThread.scripting.reactCommit.share,
  xtermParsing: (one: PhaseResult) => one.breakdown?.mainThread.scripting.xtermParsing.share,
  xtermRendering: (one: PhaseResult) => one.breakdown?.mainThread.scripting.xtermRendering.share,
  store: (one: PhaseResult) => one.breakdown?.mainThread.scripting.store.share,
  transport: (one: PhaseResult) => one.breakdown?.mainThread.scripting.transport.share,
  garbageCollection: (one: PhaseResult) =>
    one.breakdown?.mainThread.scripting.garbageCollection.share,
  otherScript: (one: PhaseResult) => one.breakdown?.mainThread.scripting.otherScript.share,
  styleLayout: (one: PhaseResult) => one.breakdown?.mainThread.styleLayout.share,
  paintComposite: (one: PhaseResult) => one.breakdown?.mainThread.paintComposite.share,
  other: (one: PhaseResult) => one.breakdown?.mainThread.other.share,
  selfReact: (one: PhaseResult) => one.breakdown?.selfBySource.react.share,
  selfXtermParser: (one: PhaseResult) => one.breakdown?.selfBySource.xtermParser.share,
  selfXtermRenderer: (one: PhaseResult) => one.breakdown?.selfBySource.xtermRenderer.share,
  selfXterm: (one: PhaseResult) => one.breakdown?.selfBySource.xterm.share,
  selfProtocol: (one: PhaseResult) => one.breakdown?.selfBySource.protocol.share,
  selfPackages: (one: PhaseResult) => one.breakdown?.selfBySource.packages.share,
  selfApp: (one: PhaseResult) => one.breakdown?.selfBySource.app.share,
  selfUnmapped: (one: PhaseResult) => one.breakdown?.selfBySource.unmapped.share,
  tracksRender: (one: PhaseResult) => one.breakdown?.reactTracks?.render.share,
  tracksCommit: (one: PhaseResult) => one.breakdown?.reactTracks?.commit.share,
  storeSpans: (one: PhaseResult) => one.breakdown?.storeSpans?.share,
  reactOfBusy: (one: PhaseResult) =>
    one.breakdown && ofBusy(reactMs(one.breakdown), one.breakdown.mainThread.ms),
  statePropagationOfBusy: (one: PhaseResult) =>
    one.breakdown && ofBusy(propagationMs(one.breakdown), one.breakdown.mainThread.ms),
  reactSelfOfBusy: (one: PhaseResult) =>
    one.breakdown && ofBusy(one.breakdown.selfBySource.react.ms, one.breakdown.mainThread.ms),
  reactTracksOfBusy: (one: PhaseResult) =>
    one.breakdown && ofBusy(tracksMs(one.breakdown), one.breakdown.mainThread.ms),
  paintCompositeOfBusy: (one: PhaseResult) =>
    one.breakdown &&
    ofBusy(one.breakdown.mainThread.paintComposite.ms, one.breakdown.mainThread.ms),
  transportOfBusy: (one: PhaseResult) =>
    one.breakdown &&
    ofBusy(one.breakdown.mainThread.scripting.transport.ms, one.breakdown.mainThread.ms),
  // What a frame costs the main thread, which still moves once it is saturated, when its
  // busy share can't.
  busyMsPerFrame: (one: PhaseResult) =>
    one.breakdown && one.frames > 0 ? one.breakdown.mainThread.ms / one.frames : undefined,
  fps: (one: PhaseResult) => one.fps,
  framesOver33ms: (one: PhaseResult) => one.framesOver33ms,
  longTasks: (one: PhaseResult) => one.longTasks,
  compositorFps: (one: PhaseResult) => one.breakdown?.compositorFps,
  compositorThread: (one: PhaseResult) => one.breakdown?.threads.Compositor?.share,
  rasterThreads: (one: PhaseResult) => one.breakdown?.threads.raster?.share,
  vizThread: (one: PhaseResult) => one.breakdown?.threads.VizCompositorThread?.share,
  gpuMainThread: (one: PhaseResult) => one.breakdown?.threads.CrGpuMain?.share,
  switchP50Ms: (one: PhaseResult) => percentile(timed(one.switches), 0.5) ?? undefined,
  switchP90Ms: (one: PhaseResult) => percentile(timed(one.switches), 0.9) ?? undefined,
  switchesTimedOut: (one: PhaseResult) =>
    one.phase === "switches"
      ? one.switches.filter((each) => each.ms === undefined).length
      : undefined,
} as const

export type Metric = keyof typeof metrics

// The numbers that need the script split by the source maps, which a run whose build
// couldn't be mapped doesn't give: they'd read 0, as if measured.
const split = new Set<string>([
  "reactRender",
  "reactCommit",
  "xtermParsing",
  "xtermRendering",
  "store",
  "transport",
  "garbageCollection",
  "otherScript",
  "selfReact",
  "selfXtermParser",
  "selfXtermRenderer",
  "selfXterm",
  "selfProtocol",
  "selfPackages",
  "selfApp",
  "selfUnmapped",
  "statePropagationOfBusy",
  "reactOfBusy",
  "reactSelfOfBusy",
  "transportOfBusy",
])

const timed = (switches: readonly Switch[]) =>
  switches.flatMap((each) => (each.ms === undefined ? [] : [each.ms]))

/** A run's phases' time together, in ms, as `read` gives it from each phase's breakdown. */
const pooled = (run: RunResult, read: (one: Breakdown) => number | undefined) => {
  const values = run.phases.flatMap((one) => {
    const value = one.breakdown && read(one.breakdown)
    return value === undefined ? [] : [value]
  })
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0)
}

/**
 * The numbers the plan's triggers read, from a run's phases together, as shares of the main
 * thread's busy time, its non-idle time.
 */
export const triggers = {
  statePropagationOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, propagationMs),
      pooled(run, (one) => one.mainThread.ms),
    ),
  storeSpansOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, (one) => one.storeSpans?.ms),
      pooled(run, (one) => one.mainThread.ms),
    ),
  reactOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, reactMs),
      pooled(run, (one) => one.mainThread.ms),
    ),
  reactSelfOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, (one) => one.selfBySource.react.ms),
      pooled(run, (one) => one.mainThread.ms),
    ),
  reactTracksOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, tracksMs),
      pooled(run, (one) => one.mainThread.ms),
    ),
  transportOfBusy: (run: RunResult) =>
    ofBusy(
      pooled(run, (one) => one.mainThread.scripting.transport.ms),
      pooled(run, (one) => one.mainThread.ms),
    ),
} as const

export type Trigger = keyof typeof triggers

/** The phase's numbers from what the page recorded; the trace's come with `breakdown`. */
export const pageNumbers = (
  frameGaps: readonly number[],
  longTasks: readonly number[],
): Pick<PhaseResult, "fps" | "frames" | "framesOver33ms" | "longTasks"> => {
  const total = frameGaps.reduce((sum, gap) => sum + gap, 0)
  return {
    fps: total > 0 ? frameGaps.length / (total / 1000) : 0,
    frames: frameGaps.length,
    framesOver33ms: frameGaps.filter((gap) => gap > 33).length,
    longTasks: longTasks.length,
  }
}

/** One scenario on one build: each phase's numbers, and its runs' together. */
export type ScenarioSummary = {
  readonly phases: Partial<Record<PhaseName, Partial<Record<Metric, Spread>>>>
  readonly triggers: Partial<Record<Trigger, Spread>>
}

export type Summary = Partial<Record<Variant, Partial<Record<ScenarioName, ScenarioSummary>>>>

const spreadOf = <T>(items: readonly T[], read: (item: T) => number | undefined) =>
  spread(
    items.flatMap((item) => {
      const value = read(item)
      return value === undefined ? [] : [value]
    }),
  )

/**
 * Frames a second under which a phase ran throttled, as Chromium runs a page whose screen has
 * gone dark, as the desktop's idle blanking does: its numbers measure the throttling, not the
 * app. It's the compositor's frames that tell: they go on while the main thread is busy, even
 * saturated, and only slow to about one a second once the screen is dark. Without a trace,
 * the page's own animation frames stand in.
 */
export const throttledFps = 5

/** Whether the phase ran throttled (see `throttledFps`). */
export const throttled = (one: PhaseResult): boolean =>
  (one.breakdown?.compositorFps ?? one.fps) < throttledFps

/** Each run's phases that ran throttled, as `<scenario>, <variant>, run <n>: <phase>`. */
export const throttledPhases = (runs: readonly RunResult[]): readonly string[] =>
  runs.flatMap((run) =>
    run.phases
      .filter(throttled)
      .map((one) => `${run.scenario}, ${run.variant}, run ${run.run}: ${one.phase}`),
  )

/**
 * Each build's scenarios' numbers across their runs: a throttled phase's are left out, and
 * the triggers, which take a run's phases together, count only runs that have them all.
 */
export const summarize = (runs: readonly RunResult[]): Summary => {
  const summary: Partial<Record<Variant, Partial<Record<ScenarioName, ScenarioSummary>>>> = {}
  for (const variant of new Set(runs.map((run) => run.variant)))
    for (const scenario of new Set(
      runs.filter((run) => run.variant === variant).map((run) => run.scenario),
    )) {
      const these = runs.filter((run) => run.variant === variant && run.scenario === scenario)
      const phases: ScenarioSummary["phases"] = {}
      for (const phase of new Set(these.flatMap((run) => run.phases.map((one) => one.phase)))) {
        const of = (mapped: boolean) =>
          these
            .filter((run) => !mapped || run.attributed)
            .flatMap((run) => run.phases.filter((one) => one.phase === phase && !throttled(one)))
        const numbers: Partial<Record<Metric, Spread>> = {}
        for (const [name, read] of Object.entries(metrics) as [
          Metric,
          (one: PhaseResult) => number | undefined,
        ][]) {
          const found = spreadOf(of(split.has(name)), read)
          if (found) numbers[name] = found
        }
        phases[phase] = numbers
      }
      // The triggers take a run's phases together, so only a run that has them all, each
      // read and none throttled, counts: one that failed part way would read as its first.
      const phaseCount = Math.max(0, ...these.map((run) => run.phases.length))
      const whole = (run: RunResult) =>
        run.error === undefined &&
        run.phases.length === phaseCount &&
        run.phases.every((one) => one.breakdown !== undefined && !throttled(one))
      const found: Partial<Record<Trigger, Spread>> = {}
      for (const [name, read] of Object.entries(triggers) as [
        Trigger,
        (run: RunResult) => number | undefined,
      ][]) {
        const each = spreadOf(
          these.filter((run) => (!split.has(name) || run.attributed) && whole(run)),
          read,
        )
        if (each) found[name] = each
      }
      ;(summary[variant] ??= {})[scenario] = { phases, triggers: found }
    }
  return summary
}

/**
 * Each phase's `metric`, the main thread's busy share by default, its median on the
 * production build and on `variant`, and the difference: what React's profiling build costs,
 * or what xterm's WebGL renderer saves.
 */
export const compared = (
  summary: Summary,
  variant: Exclude<Variant, "production">,
  metric: Metric = "mainThread",
): Partial<
  Record<
    ScenarioName,
    Partial<
      Record<
        PhaseName,
        { readonly production: number; readonly variant: number; readonly points: number }
      >
    >
  >
> =>
  Object.fromEntries(
    Object.entries(summary.production ?? {}).flatMap(([scenario, production]) => {
      const other = summary[variant]?.[scenario as ScenarioName]
      if (!other) return []
      const phases = Object.entries(production.phases).flatMap(([phase, numbers]) => {
        const base = numbers[metric]?.median
        const measured = other.phases[phase as PhaseName]?.[metric]?.median
        return base === undefined || measured === undefined
          ? []
          : [[phase, { production: base, variant: measured, points: measured - base }]]
      })
      return [[scenario, Object.fromEntries(phases)]]
    }),
  )

const labels: Readonly<Record<Metric, string>> = {
  mainThread: "Main thread busy",
  scripting: "Scripting",
  reactRender: "· React render",
  reactCommit: "· React commit",
  xtermParsing: "· xterm parsing",
  xtermRendering: "· xterm rendering (script)",
  store: "· stores: dispatch, listeners, selectors",
  transport: "· transport (oRPC, protocol, output events)",
  garbageCollection: "· garbage collection",
  otherScript: "· other script",
  styleLayout: "Style and layout",
  paintComposite: "Paint and composite",
  other: "Other main-thread work",
  selfReact: "Script self time: React, React DOM, scheduler",
  selfXtermParser: "Script self time: xterm's parser",
  selfXtermRenderer: "Script self time: xterm's renderer",
  selfXterm: "Script self time: the rest of xterm",
  selfProtocol: "Script self time: oRPC and protocol",
  selfPackages: "Script self time: other packages",
  selfApp: "Script self time: the app's own",
  selfUnmapped: "Script self time: unmapped",
  tracksRender: "React's tracks: render",
  tracksCommit: "React's tracks: commit and effects",
  storeSpans: "Store listener spans",
  statePropagationOfBusy: "State propagation, of busy (stores + React render + commit)",
  reactOfBusy: "React render + commit, of busy (work loop)",
  reactSelfOfBusy: "React's own frames, of busy (self time)",
  reactTracksOfBusy: "React render + commit, of busy (React's tracks)",
  paintCompositeOfBusy: "Paint and composite, of busy",
  transportOfBusy: "Transport, of busy",
  busyMsPerFrame: "Main thread busy a frame (ms)",
  fps: "fps (animation frames)",
  framesOver33ms: "Frames over 33 ms",
  longTasks: "Long tasks",
  compositorFps: "Frames drawn a second (compositor)",
  compositorThread: "Renderer compositor thread busy",
  rasterThreads: "Raster tasks off the main thread (summed)",
  vizThread: "GPU process viz thread busy",
  gpuMainThread: "GPU process main thread busy",
  switchP50Ms: "Switch p50 (ms)",
  switchP90Ms: "Switch p90 (ms)",
  switchesTimedOut: "Switches timed out",
}

const counts = new Set<string>([
  "fps",
  "framesOver33ms",
  "longTasks",
  "compositorFps",
  "switchP50Ms",
  "switchP90Ms",
  "switchesTimedOut",
  "busyMsPerFrame",
])

const shown = (metric: string, value: number) =>
  !counts.has(metric)
    ? `${value.toFixed(1)}%`
    : Number.isInteger(value)
      ? String(value)
      : value.toFixed(1)

const cell = (metric: string, found: Spread | undefined) =>
  found
    ? `${shown(metric, found.median)} (${shown(metric, found.min)}–${shown(metric, found.max)})`
    : "–"

const builds: Readonly<Record<Variant, string>> = {
  production: "production build",
  profiling: "React's profiling build",
  webgl: "xterm's WebGL renderer",
}

const percent = (value: number | undefined) => (value === undefined ? "–" : `${value.toFixed(1)}%`)

/** How much less, in percent, a comparison's variant took than the production build. */
const cut = (each: { production: number; points: number } | undefined) =>
  each && each.production > 0 ? (-each.points / each.production) * 100 : undefined

// A main thread this busy has no time to give back: what it saves goes to more frames.
const saturated = 95

/**
 * Grid's busy share with the DOM renderer and with WebGL, and how much less WebGL takes,
 * relatively: of the window, and of each frame, which still moves once the main thread is
 * saturated; and whether either side was.
 */
const webglCut = (summary: Summary, scenario: ScenarioName) => {
  const share = compared(summary, "webgl")[scenario]?.grid
  const perFrame = compared(summary, "webgl", "busyMsPerFrame")[scenario]?.grid
  return {
    production: share?.production,
    webgl: share?.variant,
    shareCut: cut(share),
    frameCut: cut(perFrame),
    saturated: Boolean(share && Math.max(share.production, share.variant) >= saturated),
  }
}

/**
 * The summary as markdown: the triggers a scenario, React's profiling build's overhead, then
 * a table a scenario and build, a row a number and a column a phase, each cell the median
 * and the range across runs.
 */
export const markdown = (
  summary: Summary,
  heading: { readonly title: string; readonly lines: readonly string[] },
): string => {
  const out = [`# ${heading.title}`, "", ...heading.lines, ""]
  const scenarios = [
    ...new Set(Object.values(summary).flatMap((each) => Object.keys(each ?? {}))),
  ] as ScenarioName[]
  out.push(
    "## Triggers",
    "",
    "Each run's phases together, as shares of the main thread's busy (non-idle) time; Grid's busy time is of its window.",
    "",
    "| | State propagation | React render + commit (work loop) | React's own frames (self time) | React render + commit (React's tracks) | Store listener spans | Transport | Grid busy, DOM renderer | Grid busy, WebGL renderer | WebGL's cut, of the window | WebGL's cut, a frame |",
    "|---|---|---|---|---|---|---|---|---|---|---|",
    ...scenarios.map((scenario) => {
      const production = summary.production?.[scenario]?.triggers
      const profiling = summary.profiling?.[scenario]?.triggers
      const webgl = webglCut(summary, scenario)
      return `| ${scenario} | ${[
        cell("statePropagationOfBusy", production?.statePropagationOfBusy),
        cell("reactOfBusy", production?.reactOfBusy),
        cell("reactSelfOfBusy", production?.reactSelfOfBusy),
        cell("reactTracksOfBusy", profiling?.reactTracksOfBusy),
        cell("storeSpansOfBusy", profiling?.storeSpansOfBusy),
        cell("transportOfBusy", production?.transportOfBusy),
        percent(webgl.production),
        percent(webgl.webgl),
        `${percent(webgl.shareCut)}${webgl.saturated ? " (saturated)" : ""}`,
        percent(webgl.frameCut),
      ].join(" | ")} |`
    }),
    "",
    "- State propagation, step 4.0's number: the production build's CPU samples in the stores (their dispatch with its reducers, their updates, the listeners they wake and the selectors those read, React's store check included) and under React's work loop, by the nearest frame.",
    "- React render + commit (work loop): the production build's CPU samples under React's work loop, components and effects included: state propagation without the stores' part.",
    "- React's own frames (self time): the production build's samples whose own frame is in React, React DOM or the scheduler, bottom up: React's own cost, without the components it runs.",
    "- React render + commit (React's tracks): the time React's profiling build logs as its render and commit phases, from that build's runs; what the build costs is below.",
    "- Store listener spans: from React's profiling build's runs, the time from the first listener a task wakes to the end of the task's script, measured through the stores' hook once step 1.3a has added it; – until then.",
    "- Transport: oRPC, the protocol's client side and the UI's handling of a terminal's events, by the nearest frame; T7 runs if it is over 5%.",
    "- WebGL's cut: how much less, relatively, the main thread is busy in Grid with xterm's WebGL renderer loaded, medians, of the window and of each animation frame; E4 runs if it is 20% or more in the heavy scenario. A main thread busy 95% or more on either build is marked saturated: what it saves goes to more frames, so the cut of the window reads low, and the cut a frame is the one to read.",
    "",
  )
  const costs = compared(summary, "profiling")
  if (Object.keys(costs).length > 0) {
    out.push(
      "## React's profiling build's overhead",
      "",
      "Main thread busy, of the window and in ms a frame, median across runs; a saturated main thread's share can't grow, so its frames show the cost.",
      "",
      "| | phase | production build | profiling build | difference | production, a frame | profiling, a frame |",
      "|---|---|---|---|---|---|---|",
    )
    const perFrame = compared(summary, "profiling", "busyMsPerFrame")
    for (const [scenario, phases] of Object.entries(costs))
      for (const [phase, each] of Object.entries(phases ?? {})) {
        const frame = perFrame[scenario as ScenarioName]?.[phase as PhaseName]
        out.push(
          `| ${scenario} | ${phase} | ${each.production.toFixed(1)}% | ${each.variant.toFixed(1)}% | ${each.points >= 0 ? "+" : ""}${each.points.toFixed(1)} points | ${frame ? `${frame.production.toFixed(1)} ms` : "–"} | ${frame ? `${frame.variant.toFixed(1)} ms` : "–"} |`,
        )
      }
    out.push("")
  }
  for (const [variant, scenarioSummaries] of Object.entries(summary) as [
    Variant,
    Summary[Variant],
  ][])
    for (const [scenario, { phases }] of Object.entries(scenarioSummaries ?? {})) {
      const names = Object.keys(phases) as PhaseName[]
      out.push(
        `## ${scenario}, ${builds[variant]}`,
        "",
        `| | ${names.join(" | ")} |`,
        `|---|${names.map(() => "---").join("|")}|`,
      )
      for (const metric of Object.keys(labels) as Metric[]) {
        const cells = names.map((phase) => cell(metric, phases[phase]?.[metric]))
        if (cells.some((each) => each !== "–"))
          out.push(`| ${labels[metric]} | ${cells.join(" | ")} |`)
      }
      out.push("")
    }
  return `${out.join("\n")}\n`
}
