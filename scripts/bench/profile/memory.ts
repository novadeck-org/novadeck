import { readFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import { sleep } from "../timing/drive.ts"
import type { OpenedApp } from "./app.ts"
import { readGl, type GlReport } from "./gpu.ts"
import { spread, type RunResult, type Spread } from "./summary.ts"
import type { TraceEvent } from "./trace.ts"

// The app's memory, read outside the timed phases, as they would otherwise carry the cost of the
// dumps. A sample is a short Chromium trace of the `disabled-by-default-memory-infra` category
// alone, with detailed dumps taken every `dumpEveryMs`: the last complete one is read, every
// process's own totals and allocator dumps. The GPU process's dumps carry the textures
// (`gpu/gl`, `gpu/shared_images`, `skia/gpu_resources` and a Dawn or Vulkan allocator where the
// backend has one: the sample keeps every dump two levels deep, so the run says which), the
// renderer's carry its private footprint. Beside them, Electron's `app.getAppMetrics()` per
// process, whose private memory is Windows-only, and on Linux each process's `smaps_rollup`.

const dumpEveryMs = 500
// Long enough for a second dump to finish: a detailed dump of a renderer with many terminals
// takes a good part of a second.
const sampleMs = 3000

const memoryTrace: Electron.TraceConfig = {
  recording_mode: "record-until-full",
  trace_buffer_size_in_kb: 256 * 1024,
  included_categories: ["__metadata", "disabled-by-default-memory-infra"],
  memory_dump_config: { triggers: [{ mode: "detailed", periodic_interval_ms: dumpEveryMs }] },
}

/** A dump node's own numbers in MB; effective is Chromium's, which counts shared memory once. */
export type Node = { readonly size: number; readonly effective?: number }

/** A process as the trace names it. */
export type Kind = "gpu" | "renderer" | "browser" | "utility" | "other"

export type ProcessMemory = {
  readonly pid: number
  readonly kind: Kind
  readonly name: string
  /** Chromium's private footprint, in MB, from the dump's process totals. */
  readonly privateFootprintMB?: number
  /** Electron's working set, MB. */
  readonly workingSetMB?: number
  /** Electron's private bytes, MB: Windows only. */
  readonly privateBytesMB?: number
  /** Linux `smaps_rollup`: Rss, Pss and private (clean plus dirty), MB. */
  readonly smaps?: { readonly rssMB: number; readonly pssMB: number; readonly privateMB: number }
  /** The dumps' nodes two levels deep (`gpu/shared_images`), by path. */
  readonly nodes: Readonly<Record<string, Node>>
}

export type MemoryPoint = "boot" | "grid" | "focus" | "switches"

export type MemorySample = {
  readonly point: MemoryPoint
  /** Terminals opened in the session. */
  readonly terminals: number
  readonly gl: GlReport
  readonly processes: readonly ProcessMemory[]
  /** Dumps read, or why none was: a sample with none has no process totals. */
  readonly dumps: number
  readonly error?: string
}

const MB = 1024 ** 2

type Dump = {
  readonly allocators?: Record<string, { attrs?: Record<string, { type: string; value: string }> }>
  readonly process_totals?: Record<string, unknown>
}

const scalar = (
  node: { attrs?: Record<string, { type: string; value: string }> },
  name: string,
): number | undefined => {
  const found = node.attrs?.[name]
  return found?.type === "scalar" ? Number.parseInt(found.value, 16) / MB : undefined
}

const kindOf = (name: string): Kind =>
  name === "GPU Process"
    ? "gpu"
    : name === "Renderer"
      ? "renderer"
      : name === "Browser"
        ? "browser"
        : /^(Utility|Service:)/.test(name)
          ? "utility"
          : "other"

// Nodes with an id for a name, which only add noise two levels deep.
// The renderer's `webgl` node holds every context's; its parts are only ids.
const noise = /^(shared_memory|parkable_strings|webgl)\//

/**
 * The last global dump in the trace, by process: its totals and its nodes two levels deep, as
 * a global dump arrives as several events a process (the totals, then the allocators).
 */
export const lastDumps = (events: readonly TraceEvent[]): readonly ProcessMemory[] => {
  const names = new Map<number, string>()
  for (const one of events)
    if (one.ph === "M" && one.name === "process_name")
      names.set(one.pid, String((one.args as { name?: unknown } | undefined)?.name ?? ""))
  const dumps = events.filter((one) => one.ph === "v")
  // The trace's end may cut the last dump short: the last whose GPU process has allocators
  // is the one read.
  const ids = [...new Set(dumps.map((one) => one.id ?? ""))]
  const complete = (id: string) =>
    dumps.some(
      (one) =>
        one.id === id &&
        kindOf(names.get(one.pid) ?? "") === "gpu" &&
        Object.keys((one.args as { dumps?: Dump } | undefined)?.dumps?.allocators ?? {}).length > 0,
    )
  const id = ids.findLast(complete)
  if (id === undefined) return []
  const processes = new Map<
    number,
    { totals: Record<string, unknown> | undefined; allocators: NonNullable<Dump["allocators"]> }
  >()
  for (const one of dumps) {
    if (one.id !== id) continue
    const dump = (one.args as { dumps?: Dump } | undefined)?.dumps
    if (!dump) continue
    const found = processes.get(one.pid) ?? { totals: undefined, allocators: {} }
    processes.set(one.pid, {
      totals: dump.process_totals ?? found.totals,
      allocators: { ...found.allocators, ...dump.allocators },
    })
  }
  return [...processes].map(([pid, { totals, allocators }]) => {
    const name = names.get(pid) ?? `pid ${pid}`
    const nodes: Record<string, Node> = {}
    for (const [path, node] of Object.entries(allocators ?? {})) {
      if (path.split("/").length > 2 || noise.test(path)) continue
      const size = scalar(node, "size")
      if (size === undefined) continue
      const effective = scalar(node, "effective_size")
      nodes[path] = { size, ...(effective !== undefined && { effective }) }
    }
    const footprint = totals?.private_footprint_bytes
    return {
      pid,
      kind: kindOf(name),
      name,
      ...(typeof footprint === "string" && {
        privateFootprintMB: Number.parseInt(footprint, 16) / MB,
      }),
      nodes,
    }
  })
}

/** Linux: a process's Rss, Pss and private memory, MB; nothing where /proc doesn't say. */
const smapsOf = (pid: number): ProcessMemory["smaps"] => {
  try {
    const text = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8")
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, "m").exec(text)?.[1])
    const read = {
      rssMB: kb("Rss") / 1024,
      pssMB: kb("Pss") / 1024,
      privateMB: (kb("Private_Clean") + kb("Private_Dirty")) / 1024,
    }
    return Object.values(read).every(Number.isFinite) ? read : undefined
  } catch {
    return undefined
  }
}

const metricKind = (type: string): Kind =>
  type === "GPU"
    ? "gpu"
    : type === "Tab"
      ? "renderer"
      : type === "Browser"
        ? "browser"
        : type === "Utility"
          ? "utility"
          : "other"

/**
 * Samples the app's memory now: a short memory-infra trace, Electron's metrics and the page's
 * WebGL screens, as at `point`, with `terminals` opened. A sample that fails says why, with
 * what it got; the run goes on.
 */
export const sampleMemory = async (
  opened: OpenedApp,
  point: MemoryPoint,
  terminals: number,
): Promise<MemorySample> => {
  const gl = await readGl(opened.page)
  const path = join(opened.scratch, `memory-${point}.json`)
  let dumped: readonly ProcessMemory[] = []
  let error: string | undefined
  try {
    await opened.app.evaluate(
      ({ contentTracing }, config) => contentTracing.startRecording(config),
      memoryTrace,
    )
    await sleep(sampleMs)
    const written = await opened.app.evaluate(
      ({ contentTracing }, where) => contentTracing.stopRecording(where),
      path,
    )
    const parsed = JSON.parse(readFileSync(written, "utf8")) as { traceEvents?: TraceEvent[] }
    dumped = lastDumps(parsed.traceEvents ?? [])
    if (dumped.length === 0) error = "no complete memory dump in the trace"
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause)
  } finally {
    rmSync(path, { force: true })
  }
  const metrics = await opened.app
    .evaluate(({ app }) => app.getAppMetrics())
    .catch(() => [] as Electron.ProcessMetric[])
  const processes: ProcessMemory[] = dumped.map((one) => {
    const metric = metrics.find((each) => each.pid === one.pid)
    const smaps = process.platform === "linux" ? smapsOf(one.pid) : undefined
    return {
      ...one,
      ...(metric && { workingSetMB: metric.memory.workingSetSize / 1024 }),
      ...(metric?.memory.privateBytes !== undefined && {
        privateBytesMB: metric.memory.privateBytes / 1024,
      }),
      ...(smaps && { smaps }),
    }
  })
  // Processes Electron knows and the dump missed still have a working set.
  for (const metric of metrics)
    if (!processes.some((one) => one.pid === metric.pid))
      processes.push({
        pid: metric.pid,
        kind: metricKind(metric.type),
        name: metric.name ?? metric.serviceName ?? metric.type,
        workingSetMB: metric.memory.workingSetSize / 1024,
        ...(process.platform === "linux" && smapsOf(metric.pid) && { smaps: smapsOf(metric.pid)! }),
        nodes: {},
      })
  return {
    point,
    terminals,
    gl,
    processes,
    dumps: dumped.length,
    ...(error !== undefined && { error }),
  }
}

// --- The report --------------------------------------------------------------------------

const points: readonly MemoryPoint[] = ["boot", "grid", "focus", "switches"]

type Row = { readonly label: string; readonly read: (sample: MemorySample) => number | undefined }

const of = (sample: MemorySample, kind: Kind): ProcessMemory | undefined =>
  sample.processes.find((one) => one.kind === kind)

const node =
  (kind: Kind, path: string): Row["read"] =>
  (sample) => {
    const found = of(sample, kind)?.nodes[path]
    return found && (found.effective ?? found.size)
  }

const sizeOf =
  (kind: Kind, path: string): Row["read"] =>
  (sample) =>
    of(sample, kind)?.nodes[path]?.size

/**
 * The rows a table of samples shows: the page's screens and atlases, then, by process, the
 * numbers each source gives, and every dump node two levels deep that reaches `floor` MB in
 * any sample, as which of them carries the textures depends on the GPU and the driver.
 */
const rowsFor = (samples: readonly MemorySample[]): readonly Row[] => {
  const nodes = (kind: Kind, floor: number): Row[] => {
    const seen = samples.flatMap((sample) => Object.entries(of(sample, kind)?.nodes ?? {}))
    const paths = [...new Set(seen.map(([path]) => path))]
    return paths
      .toSorted()
      .filter(
        (path) =>
          // A node with parts shows through them: its total is the sum, mostly.
          !paths.some((other) => other.startsWith(`${path}/`)) &&
          seen.some(([each, found]) => each === path && found.size >= floor),
      )
      .flatMap((path) => [
        { label: `${kind} dump \`${path}\` (size)`, read: sizeOf(kind, path) },
        // Only where sharing makes it differ.
        ...(seen.some(
          ([each, found]) =>
            each === path &&
            found.effective !== undefined &&
            Math.abs(found.effective - found.size) >= 0.05,
        )
          ? [{ label: `${kind} dump \`${path}\` (effective)`, read: node(kind, path) }]
          : []),
      ])
  }
  return [
    { label: "Terminals opened", read: (sample) => sample.terminals },
    { label: "Terminals mounted", read: (sample) => sample.gl.mounted },
    { label: "Terminals in view", read: (sample) => sample.gl.inView },
    { label: "Screens holding a WebGL context", read: (sample) => sample.gl.withContext },
    {
      label: "Contexts lost (screens now, addons told)",
      read: (sample) => sample.gl.contextLost + (sample.gl.lostEvents ?? 0),
    },
    { label: "Atlases", read: (sample) => sample.gl.atlases.length },
    {
      label: "Atlas pages",
      read: (sample) => sample.gl.atlases.reduce((sum, one) => sum + one.pages.length, 0),
    },
    {
      label: "Atlas pages, all atlases (MB, one copy)",
      read: (sample) => sample.gl.atlases.reduce((sum, one) => sum + one.pagesMB, 0),
    },
    {
      label: "Contexts holding an atlas (most on one)",
      read: (sample) => Math.max(0, ...sample.gl.atlases.map((one) => one.contexts)),
    },
    {
      label: "Atlas textures, pages times contexts (MB)",
      read: (sample) => sample.gl.atlasTexturesMB,
    },
    {
      label: "GPU process, private footprint (dump, MB)",
      read: (sample) => of(sample, "gpu")?.privateFootprintMB,
    },
    {
      label: "GPU process, Linux private (smaps, MB)",
      read: (sample) => of(sample, "gpu")?.smaps?.privateMB,
    },
    {
      label: "GPU process, Linux Pss (smaps, MB)",
      read: (sample) => of(sample, "gpu")?.smaps?.pssMB,
    },
    {
      label: "GPU process, Linux Rss (smaps, MB)",
      read: (sample) => of(sample, "gpu")?.smaps?.rssMB,
    },
    {
      label: "GPU process, working set (Electron, MB)",
      read: (sample) => of(sample, "gpu")?.workingSetMB,
    },
    {
      label: "GPU process, private bytes (Electron, Windows only, MB)",
      read: (sample) => of(sample, "gpu")?.privateBytesMB,
    },
    ...nodes("gpu", 1),
    {
      label: "Renderer, private footprint (dump, MB)",
      read: (sample) => of(sample, "renderer")?.privateFootprintMB,
    },
    {
      label: "Renderer, Linux private (smaps, MB)",
      read: (sample) => of(sample, "renderer")?.smaps?.privateMB,
    },
    {
      label: "Renderer, Linux Pss (smaps, MB)",
      read: (sample) => of(sample, "renderer")?.smaps?.pssMB,
    },
    {
      label: "Renderer, Linux Rss (smaps, MB)",
      read: (sample) => of(sample, "renderer")?.smaps?.rssMB,
    },
    {
      label: "Renderer, working set (Electron, MB)",
      read: (sample) => of(sample, "renderer")?.workingSetMB,
    },
    {
      label: "Renderer, private bytes (Electron, Windows only, MB)",
      read: (sample) => of(sample, "renderer")?.privateBytesMB,
    },
    ...nodes("renderer", 5),
    {
      label: "Browser, private footprint (dump, MB)",
      read: (sample) => of(sample, "browser")?.privateFootprintMB,
    },
    {
      label: "Browser, working set (Electron, MB)",
      read: (sample) => of(sample, "browser")?.workingSetMB,
    },
  ]
}

const number = (value: number) => (Number.isInteger(value) ? String(value) : value.toFixed(1))

const shown = (found: Spread | undefined) =>
  !found
    ? "–"
    : found.min === found.max
      ? number(found.median)
      : `${number(found.median)} (${number(found.min)}–${number(found.max)})`

/**
 * profile.md's memory section: a table for each scenario and build, a row a number and a column
 * a point of the run (at boot with no terminal, then after Grid, Focus and the switches),
 * each cell the median and the range across runs. A row of a number no sample gave is left out.
 */
export const memoryMarkdown = (runs: readonly RunResult[]): string => {
  const out: string[] = []
  const groups = new Map<string, RunResult[]>()
  for (const run of runs)
    if (run.memory?.length) {
      const key = `${run.scenario}, ${run.variant}`
      groups.set(key, [...(groups.get(key) ?? []), run])
    }
  if (groups.size === 0) return ""
  out.push(
    "## Memory",
    "",
    "Sampled outside the timed phases: a memory-infra trace's last detailed dump (Chromium's own numbers, MB), Electron's `getAppMetrics()` (private bytes on Windows only) and, on Linux, each process's `smaps_rollup`. A dump's *size* is what the allocator holds; its *effective* size counts memory shared with another process once. Dump nodes are listed by path, a node with parts through its parts, where they reach 1 MB in the GPU process, 5 MB in the renderer; which of them carry the textures depends on the GPU and the driver.",
    "",
  )
  for (const [key, group] of groups) {
    const samples = group.flatMap((run) => run.memory ?? [])
    const failed = samples.filter((one) => one.error)
    out.push(
      `### ${key}`,
      "",
      `| | ${points.join(" | ")} |`,
      `|---|${points.map(() => "---").join("|")}|`,
    )
    for (const row of rowsFor(samples)) {
      const cells = points.map((point) =>
        shown(
          spread(
            group.flatMap((run) =>
              (run.memory ?? [])
                .filter((one) => one.point === point)
                .flatMap((one) => {
                  const value = row.read(one)
                  return value === undefined || Number.isNaN(value) ? [] : [value]
                }),
            ),
          ),
        ),
      )
      if (cells.some((each) => each !== "–")) out.push(`| ${row.label} | ${cells.join(" | ")} |`)
    }
    const sample = samples.findLast((one) => one.gl.atlases.length > 0)
    if (sample)
      out.push(
        "",
        `Last atlases seen (${sample.point}): ${sample.gl.atlases.map((one) => `${one.pages.length} page${one.pages.length === 1 ? "" : "s"} (${one.pages.map((page) => `${page.width}×${page.height}`).join(", ")}) held by ${one.contexts} context${one.contexts === 1 ? "" : "s"}`).join("; ")}.${sample.gl.limits ? ` Context limits: MAX_TEXTURE_SIZE ${sample.gl.limits.maxTextureSize}, MAX_TEXTURE_IMAGE_UNITS ${sample.gl.limits.maxTextureImageUnits}.` : ""}`,
      )
    if (failed.length > 0) out.push("", ...failed.map((one) => `- ${one.point}: ${one.error}`))
    out.push("")
  }
  return `${out.join("\n")}\n`
}
