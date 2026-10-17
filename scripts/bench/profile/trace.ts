// Reads a Chromium trace of one phase into where the page's main thread spent it. The window
// runs from the page's `profile-start` mark to its `profile-end`, and the mark's thread is
// the main thread. Each trace event's self time goes to a kind by its name, or by its
// nearest named ancestor: scripting, style and layout, paint and composite, or other (the
// scheduler's own work and anything unnamed). Scripting is then split by the V8 CPU
// profile's samples on that thread, each going to the nearest frame of its stack that the
// attribution names: React's render or commit, the stores' dispatch and listeners, xterm's
// parsing or rendering, the transport,
// or other script, garbage collection apart; and, bottom up, each going to the part of the
// script its own frame is in (React, xterm's parser, its renderer and the rest of it, oRPC
// and the protocol, other packages, the app's own). The
// splits' shares are the sampled time's, applied to scripting's time. React's profiling
// build adds its own record, its performance tracks, which are read as they are.

export type TraceEvent = {
  readonly name: string
  readonly cat?: string
  readonly ph: string
  readonly pid: number
  readonly tid: number
  readonly ts: number
  readonly dur?: number
  readonly id?: string
  readonly args?: Record<string, unknown>
}

export type Frame = {
  readonly functionName: string
  readonly url?: string
  readonly lineNumber?: number
  readonly columnNumber?: number
}

/** What a frame of script does, where the attribution can tell. */
export type ScriptKind =
  | "reactRender"
  | "reactCommit"
  | "xtermParsing"
  | "xtermRendering"
  | "store"
  | "transport"

/** Which part of the script a frame is in: a package, the app's own, or none known. */
export type Group =
  | "react"
  | "xtermParser"
  | "xtermRenderer"
  | "xterm"
  | "protocol"
  | "packages"
  | "app"
  | "unmapped"

export type Attribution = {
  readonly kind: (frame: Frame) => ScriptKind | undefined
  readonly group: (frame: Frame) => Group
}

export type Kind = "scripting" | "styleLayout" | "paintComposite" | "other"

const kinds: Readonly<Record<string, Kind>> = Object.fromEntries([
  ...[
    "FunctionCall",
    "EvaluateScript",
    "v8.compile",
    "v8.compileModule",
    "v8.evaluateModule",
    "v8.produceCache",
    "v8.produceModuleCache",
    "TimerFire",
    "EventDispatch",
    "FireAnimationFrame",
    "FireIdleCallback",
    "RunMicrotasks",
    "MajorGC",
    "MinorGC",
    "XHRReadyStateChange",
    "XHRLoad",
  ].map((name) => [name, "scripting"]),
  ...[
    "UpdateLayoutTree",
    "RecalculateStyles",
    "Layout",
    "HitTest",
    "ParseAuthorStyleSheet",
    "IntersectionObserverController::computeIntersections",
  ].map((name) => [name, "styleLayout"]),
  ...[
    "PrePaint",
    "Paint",
    "PaintImage",
    "PaintSetup",
    "Layerize",
    "UpdateLayer",
    "UpdateLayerTree",
    "CompositeLayers",
    "Commit",
    "ScrollLayer",
    "Decode Image",
    "ImageDecodeTask",
    "RasterTask",
  ].map((name) => [name, "paintComposite"]),
])

/** The kind an event is by its name; V8's own garbage collection events are scripting, as GC is. */
const kindOf = (name: string): Kind | undefined =>
  kinds[name] ?? (name.startsWith("V8.GC") ? "scripting" : undefined)

/** A duration with its share of the window, in percent. */
export type Part = { readonly ms: number; readonly share: number }

export type Breakdown = {
  readonly windowMs: number
  readonly mainThread: Part & {
    readonly scripting: Part & {
      readonly reactRender: Part
      readonly reactCommit: Part
      readonly xtermParsing: Part
      readonly xtermRendering: Part
      readonly store: Part
      readonly transport: Part
      readonly garbageCollection: Part
      readonly otherScript: Part
    }
    readonly styleLayout: Part
    readonly paintComposite: Part
    readonly other: Part
  }
  /** Scripting's time by the part of the script each sample's own frame was in. */
  readonly selfBySource: Readonly<Record<Group | "garbageCollection", Part>>
  /** What the samples saw on the main thread, in ms, the splits' own reading. */
  readonly sampled: Readonly<Record<ScriptKind | "garbageCollection" | "otherScript", number>> & {
    readonly bySource: Readonly<Record<Group | "garbageCollection", number>>
    readonly samples: number
    readonly intervalUs: number
  }
  /**
   * React's own record of its render and commit (effects included), from the performance
   * tracks its profiling build logs: the time its phases' entries cover. Absent from a
   * production build's trace.
   */
  readonly reactTracks?: { readonly render: Part; readonly commit: Part }
  /**
   * The time the stores' listeners ran, from the spans the profile's instrumented build
   * measures through the stores' hook (see build.ts). Absent where the build measured none.
   */
  readonly storeSpans?: Part
  /** Busy time on the other threads that draw: the renderer's compositor and raster, the GPU process. */
  readonly threads: Readonly<Record<string, Part>>
  /**
   * Frames the renderer's compositor drew, a second; absent where the trace names no
   * compositor thread.
   */
  readonly compositorFps?: number
  /** The event names whose self time went to other, longest first. */
  readonly otherNames: readonly { readonly name: string; readonly ms: number }[]
}

type Span = { readonly name: string; readonly start: number; readonly end: number }

/** The thread's complete events, and its begin and end pairs as one, clipped to the window. */
const spans = (events: readonly TraceEvent[], from: number, to: number): Span[] => {
  const result: Span[] = []
  const open = new Map<string, TraceEvent[]>()
  const add = (name: string, start: number, end: number) => {
    const clipped = { name, start: Math.max(start, from), end: Math.min(end, to) }
    if (clipped.end > clipped.start) result.push(clipped)
  }
  for (const event of events) {
    if (event.ph === "X" && event.dur !== undefined) add(event.name, event.ts, event.ts + event.dur)
    else if (event.ph === "B") open.set(event.name, [...(open.get(event.name) ?? []), event])
    else if (event.ph === "E") {
      const begun = open.get(event.name)?.pop()
      if (begun) add(begun.name, begun.ts, event.ts)
    }
  }
  // Outer first where two start together.
  return result.toSorted((a, b) => a.start - b.start || b.end - a.end)
}

/** Each span's self time, by the kind of its nearest named ancestor, and the busy total. */
const selfTimes = (
  list: readonly Span[],
): { busy: number; byKind: Record<Kind, number>; other: Map<string, number> } => {
  const byKind: Record<Kind, number> = { scripting: 0, styleLayout: 0, paintComposite: 0, other: 0 }
  const other = new Map<string, number>()
  let busy = 0
  const stack: { span: Span; kind: Kind | undefined; children: number }[] = []
  const close = (entry: { span: Span; kind: Kind | undefined; children: number }) => {
    const self = Math.max(0, entry.span.end - entry.span.start - entry.children)
    const kind = entry.kind ?? "other"
    byKind[kind] += self
    if (kind === "other") other.set(entry.span.name, (other.get(entry.span.name) ?? 0) + self)
  }
  for (const span of list) {
    while (stack.length > 0 && stack.at(-1)!.span.end <= span.start) close(stack.pop()!)
    const parent = stack.at(-1)
    // A span that outlives its parent is cut to it, as the trace's nesting holds otherwise.
    const inner = parent ? { ...span, end: Math.min(span.end, parent.span.end) } : span
    if (parent) parent.children += inner.end - inner.start
    else busy += inner.end - inner.start
    stack.push({ span: inner, kind: kindOf(span.name) ?? parent?.kind, children: 0 })
  }
  while (stack.length > 0) close(stack.pop()!)
  return { busy, byKind, other }
}

/** Busy time on a thread: its outermost spans' total. */
const busyTime = (list: readonly Span[]): number => {
  let busy = 0
  let reached = Number.NEGATIVE_INFINITY
  for (const span of list) {
    const start = Math.max(span.start, reached)
    if (span.end > start) busy += span.end - start
    reached = Math.max(reached, span.end)
  }
  return busy
}

type ProfileNode = { readonly id: number; readonly parent?: number; readonly callFrame: Frame }

/** The samples' time by what they ran, over the window, from the thread's CPU profile. */
const sampledTime = (
  events: readonly TraceEvent[],
  main: { pid: number; tid: number },
  from: number,
  to: number,
  attribution: Attribution,
): Breakdown["sampled"] => {
  const profile = events.find(
    (event) => event.name === "Profile" && event.pid === main.pid && event.tid === main.tid,
  )
  const totals = {
    reactRender: 0,
    reactCommit: 0,
    xtermParsing: 0,
    xtermRendering: 0,
    store: 0,
    transport: 0,
    garbageCollection: 0,
    otherScript: 0,
  }
  const bySource: Record<Group | "garbageCollection", number> = {
    react: 0,
    xtermParser: 0,
    xtermRenderer: 0,
    xterm: 0,
    protocol: 0,
    packages: 0,
    app: 0,
    unmapped: 0,
    garbageCollection: 0,
  }
  if (!profile) return { ...totals, bySource, samples: 0, intervalUs: 0 }
  const nodes = new Map<number, ProfileNode>()
  const byNode = new Map<number, keyof typeof totals | "none">()
  const kind = (id: number): keyof typeof totals | "none" => {
    const known = byNode.get(id)
    if (known) return known
    const node = nodes.get(id)
    let found: keyof typeof totals | "none"
    if (!node) found = "otherScript"
    else if (node.callFrame.functionName === "(garbage collector)") found = "garbageCollection"
    else if (["(idle)", "(program)", "(root)"].includes(node.callFrame.functionName)) found = "none"
    else
      found =
        attribution.kind(node.callFrame) ??
        (node.parent === undefined
          ? "otherScript"
          : kind(node.parent) === "none"
            ? "otherScript"
            : kind(node.parent))
    byNode.set(id, found)
    return found
  }
  const start = Number(
    (profile.args?.data as { startTime?: number } | undefined)?.startTime ?? profile.ts,
  )
  const times: { at: number; node: number }[] = []
  let at = start
  for (const event of events) {
    if (event.name !== "ProfileChunk" || event.pid !== main.pid || event.id !== profile.id) continue
    const data = event.args?.data as
      | { cpuProfile?: { nodes?: ProfileNode[]; samples?: number[] }; timeDeltas?: number[] }
      | undefined
    for (const node of data?.cpuProfile?.nodes ?? []) nodes.set(node.id, node)
    const samples = data?.cpuProfile?.samples ?? []
    const deltas = data?.timeDeltas ?? []
    for (const [index, node] of samples.entries()) {
      at += deltas[index] ?? 0
      times.push({ at, node })
    }
  }
  // V8 writes some deltas negative: samples count in the order they were taken.
  times.sort((a, b) => a.at - b.at)
  let counted = 0
  let spent = 0
  for (const [index, sample] of times.entries()) {
    const next = times[index + 1]
    if (!next || sample.at < from || sample.at >= to) continue
    const weight = Math.min(next.at, to) - sample.at
    const found = kind(sample.node)
    if (found !== "none") {
      totals[found] += weight / 1000
      const own = nodes.get(sample.node)?.callFrame
      const source =
        found === "garbageCollection" || !own ? "garbageCollection" : attribution.group(own)
      bySource[source] += weight / 1000
    }
    counted += 1
    spent += weight
  }
  return { ...totals, bySource, samples: counted, intervalUs: counted > 0 ? spent / counted : 0 }
}

/** How long the intervals cover, overlaps once, clipped to the window. */
const covered = (intervals: readonly { start: number; end: number }[], from: number, to: number) =>
  busyTime(
    intervals
      .map((each) => ({ name: "", start: Math.max(each.start, from), end: Math.min(each.end, to) }))
      .filter((each) => each.end > each.start)
      .toSorted((a, b) => a.start - b.start),
  )

/** The name of the spans the profile's instrumented build measures around a store's listeners. */
export const storeSpan = "novadeck:store-listeners"

/**
 * The time the page's `performance.measure` spans called `name` cover on its main thread's
 * process, overlaps once, clipped; undefined where there are none. Chromium records a measure
 * as an async begin and end, paired by id, or as a complete event.
 */
const measured = (
  events: readonly TraceEvent[],
  main: { pid: number },
  name: string,
  from: number,
  to: number,
): number | undefined => {
  const intervals: { start: number; end: number }[] = []
  const open = new Map<string, number>()
  for (const event of events) {
    if (event.name !== name || event.pid !== main.pid) continue
    const id = String(event.id ?? (event as { id2?: { local?: string } }).id2?.local ?? "")
    if (event.ph === "X" && event.dur !== undefined)
      intervals.push({ start: event.ts, end: event.ts + event.dur })
    else if (event.ph === "b") open.set(id, event.ts)
    else if (event.ph === "e") {
      const start = open.get(id)
      open.delete(id)
      if (start !== undefined) intervals.push({ start, end: event.ts })
    }
  }
  return intervals.length === 0 ? undefined : covered(intervals, from, to)
}

/**
 * The time React's profiling build logged as its render and its commit on the page's main
 * thread: the entries of its scheduler tracks, a render's (interrupted and prewarming ones
 * too) and a commit's, its remaining effects included. Undefined where it logged none.
 */
const tracks = (
  events: readonly TraceEvent[],
  main: { pid: number; tid: number },
  from: number,
  to: number,
): { render: number; commit: number } | undefined => {
  const entries = events.flatMap((event) => {
    if (event.name !== "TimeStamp" || event.pid !== main.pid || event.tid !== main.tid) return []
    const data = event.args?.data as
      | { message?: unknown; trackGroup?: unknown; start?: unknown; end?: unknown }
      | undefined
    if (data?.trackGroup !== "Scheduler ⚛") return []
    const { message, start, end } = data
    if (typeof message !== "string" || typeof start !== "number" || typeof end !== "number")
      return []
    return [{ message, start, end }]
  })
  if (entries.length === 0) return undefined
  const of = (phase: RegExp) =>
    covered(
      entries.filter((each) => phase.test(each.message)),
      from,
      to,
    )
  return { render: of(/Render$|^Prewarm$/), commit: of(/^Commit$|^Remaining Effects$/) }
}

const part = (us: number, windowUs: number): Part => ({
  ms: us / 1000,
  share: windowUs > 0 ? (us / windowUs) * 100 : 0,
})

// The threads that draw, by name. Raster has no thread of its own to name: Chromium runs its
// tasks on the renderer's pool workers, so they count by their spans (`raster` below).
const drawing: readonly { readonly label: string; readonly named: (name: string) => boolean }[] = [
  { label: "Compositor", named: (name) => name === "Compositor" },
  { label: "VizCompositorThread", named: (name) => name === "VizCompositorThread" },
  { label: "CrGpuMain", named: (name) => name === "CrGpuMain" },
]

/** Where the page's main thread spent the phase; fails on a trace without both marks. */
export const breakdown = (events: readonly TraceEvent[], attribution: Attribution): Breakdown => {
  const mark = (name: string) => events.find((event) => event.name === name && event.ph !== "M")
  const begin = mark("profile-start")
  const finish = mark("profile-end")
  if (!begin || !finish) throw new Error("the trace has no profile-start and profile-end marks")
  const from = begin.ts
  const to = finish.ts
  const windowUs = to - from
  const main = { pid: begin.pid, tid: begin.tid }
  const thread = (pid: number, tid: number) =>
    spans(
      events.filter((event) => event.pid === pid && event.tid === tid),
      from,
      to,
    )
  const { busy, byKind, other } = selfTimes(thread(main.pid, main.tid))
  const sampled = sampledTime(events, main, from, to, attribution)
  const sampledScript =
    sampled.reactRender +
    sampled.reactCommit +
    sampled.xtermParsing +
    sampled.xtermRendering +
    sampled.store +
    sampled.transport +
    sampled.garbageCollection +
    sampled.otherScript
  const react = tracks(events, main, from, to)
  const stores = measured(events, main, storeSpan, from, to)
  const scriptPart = (ms: number) =>
    part(sampledScript > 0 ? (byKind.scripting * ms) / sampledScript : 0, windowUs)
  const names = new Map<string, { pid: number; tid: number; name: string }>()
  for (const event of events)
    if (event.ph === "M" && event.name === "thread_name")
      names.set(`${event.pid}:${event.tid}`, {
        pid: event.pid,
        tid: event.tid,
        name: String((event.args as { name?: unknown } | undefined)?.name ?? ""),
      })
  const gpu = new Set(
    events
      .filter(
        (event) =>
          event.ph === "M" &&
          event.name === "process_name" &&
          (event.args as { name?: unknown } | undefined)?.name === "GPU Process",
      )
      .map((event) => event.pid),
  )
  const threads: Record<string, Part> = {}
  for (const { label, named } of drawing) {
    const matching = [...names.values()].filter(
      (each) =>
        named(each.name) &&
        // The page's own renderer, or the GPU process.
        (each.pid === main.pid || gpu.has(each.pid)),
    )
    const us = matching.reduce((sum, each) => sum + busyTime(thread(each.pid, each.tid)), 0)
    if (matching.length > 0) threads[label] = part(us, windowUs)
  }
  // The renderer's raster tasks off its main thread, each thread's time summed: none is 0.
  const rasterThreads = new Set(
    events
      .filter(
        (event) => event.name === "RasterTask" && event.pid === main.pid && event.tid !== main.tid,
      )
      .map((event) => event.tid),
  )
  threads.raster = part(
    [...rasterThreads].reduce(
      (sum, tid) =>
        sum + busyTime(thread(main.pid, tid).filter((span) => span.name === "RasterTask")),
      0,
    ),
    windowUs,
  )
  const compositor = [...names.values()].find(
    (each) => each.pid === main.pid && each.name === "Compositor",
  )
  const drawn = compositor
    ? events.filter(
        (event) =>
          event.name === "DrawFrame" &&
          event.pid === compositor.pid &&
          event.tid === compositor.tid &&
          event.ts >= from &&
          event.ts < to,
      ).length
    : 0
  return {
    windowMs: windowUs / 1000,
    mainThread: {
      ...part(busy, windowUs),
      scripting: {
        ...part(byKind.scripting, windowUs),
        reactRender: scriptPart(sampled.reactRender),
        reactCommit: scriptPart(sampled.reactCommit),
        xtermParsing: scriptPart(sampled.xtermParsing),
        xtermRendering: scriptPart(sampled.xtermRendering),
        store: scriptPart(sampled.store),
        transport: scriptPart(sampled.transport),
        garbageCollection: scriptPart(sampled.garbageCollection),
        otherScript: scriptPart(sampled.otherScript),
      },
      styleLayout: part(byKind.styleLayout, windowUs),
      paintComposite: part(byKind.paintComposite, windowUs),
      other: part(byKind.other, windowUs),
    },
    selfBySource: Object.fromEntries(
      Object.entries(sampled.bySource).map(([source, ms]) => [source, scriptPart(ms)]),
    ) as Record<Group | "garbageCollection", Part>,
    sampled,
    ...(react && {
      reactTracks: { render: part(react.render, windowUs), commit: part(react.commit, windowUs) },
    }),
    ...(stores !== undefined && { storeSpans: part(stores, windowUs) }),
    threads,
    ...(compositor && { compositorFps: windowUs > 0 ? drawn / (windowUs / 1e6) : 0 }),
    otherNames: [...other]
      .map(([name, us]) => ({ name, ms: us / 1000 }))
      .toSorted((a, b) => b.ms - a.ms)
      .slice(0, 10),
  }
}
