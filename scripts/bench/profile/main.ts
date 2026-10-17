import { execFileSync, spawnSync } from "node:child_process"
import {
  cpSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { cpus, hostname, release, totalmem, type as system } from "node:os"
import { join, relative, resolve } from "node:path"
import { pipeline } from "node:stream/promises"
import { parseArgs } from "node:util"
import { createGzip } from "node:zlib"

import { openApp, packaged, type AppRun, type Machine } from "./app.ts"
import { sourceMapped } from "./attribute.ts"
import { play, scenarios, shared, traceConfig, type Recorded, type ScenarioName } from "./drive.ts"
import {
  compared,
  markdown,
  pageNumbers,
  summarize,
  throttledFps,
  throttledPhases,
  type PhaseResult,
  type RunResult,
  type Variant,
} from "./summary.ts"
import { breakdown, type Attribution, type TraceEvent } from "./trace.ts"

// `pnpm bench:profile [--machine <name>] [--runs <n>] [--scenario timing|heavy]…
// [--variant production|profiling|webgl]… [--output <folder>] [--switch <chromium switch>]…
// [--note <text>]`: the real-hardware profile (rule 18). It runs the packaged desktop app,
// GPU on, in the timing run's sandbox with its fake agents, through each scenario (drive.ts)
// `--runs` times, 3 by default, on each build: the package's own (production), the same with
// React DOM's profiling build (profiling), whose performance tracks give React's own record
// of its render and commit, and the same with xterm's WebGL renderer in every screen
// (webgl; see build.ts). Runs take turns by scenario and build, and keep each
// phase's Chromium trace. It writes profile.json and profile.md to the output folder,
// .cache/bench/profile/<machine> by default, with the traces gzipped under traces/. The
// machine is named by `--machine`, this computer's host name by default. It exits 1 should
// any run fail or the sandbox leak, having written what it got. Linux and macOS.

const root = join(import.meta.dirname, "..", "..", "..")

const { values } = parseArgs({
  options: {
    machine: { type: "string" },
    runs: { type: "string", default: "3" },
    scenario: { type: "string", multiple: true },
    variant: { type: "string", multiple: true },
    output: { type: "string" },
    switch: { type: "string", multiple: true },
    note: { type: "string" },
  },
})
const machineName = values.machine ?? hostname()
// The name is the output folder's, under .cache/bench/profile.
if (!/\w/.test(machineName)) throw new Error(`--machine needs a letter or a digit: ${machineName}`)
const runs = Number(values.runs)
if (!Number.isInteger(runs) || runs < 1)
  throw new Error(`--runs takes a whole number: ${values.runs}`)
const chosen = (values.scenario ?? Object.keys(scenarios)) as ScenarioName[]
for (const name of chosen)
  if (!(name in scenarios))
    throw new Error(`no scenario ${name}: ${Object.keys(scenarios).join(", ")}`)
const known: readonly Variant[] = ["production", "profiling", "webgl"]
const variants = (values.variant ?? known) as Variant[]
for (const name of variants)
  if (!known.includes(name)) throw new Error(`no variant ${name}: ${known.join(", ")}`)
const output = resolve(
  values.output ??
    join(root, ".cache", "bench", "profile", machineName.replaceAll(/[^\w.-]+/g, "-")),
)
const traces = join(output, "traces")

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
})()

const describe = (cause: unknown) =>
  cause instanceof Error ? (cause.stack ?? cause.message) : String(cause)

// Attributes no frame, so scripting isn't split.
const none: Attribution = { kind: () => undefined, group: () => "unmapped" }

/** Builds the UI into `folder` with hidden source maps (build.ts), as `variant`; whether it built. */
const buildUi = (folder: string, variant: Variant): boolean =>
  spawnSync(
    process.execPath,
    [
      join(import.meta.dirname, "build.ts"),
      "--out",
      folder,
      ...(variant === "production" ? [] : [`--${variant}`]),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] },
  ).status === 0

/** The scripts of the UI build in `folder` that `shipped` doesn't hold byte for byte. */
const differing = (folder: string, shipped: string): string[] =>
  readdirSync(join(folder, "assets"))
    .filter((file) => file.endsWith(".js"))
    .filter((file) => {
      const theirs = join(shipped, "assets", file)
      return (
        !existsSync(theirs) ||
        !readFileSync(theirs).equals(readFileSync(join(folder, "assets", file)))
      )
    })

type Build = { readonly executable: string; readonly attribution: Attribution }

/**
 * The production build: the package itself, its frames attributed by the maps of the UI
 * built again, should every script match the packaged one; nothing is attributed otherwise,
 * and the reason is in `problem`.
 */
const production = (): Build & { problem?: string } => {
  const app = packaged()
  const maps = join(output, "maps", "production")
  if (!buildUi(maps, "production"))
    return { executable: app.executable, attribution: none, problem: "the UI's build failed" }
  const changed = differing(maps, join(app.resources, "ui"))
  if (changed.length > 0)
    return {
      executable: app.executable,
      attribution: none,
      problem: `the packaged UI isn't the UI built now (${changed.join(", ")}): script isn't split; package again`,
    }
  return { executable: app.executable, attribution: sourceMapped(join(maps, "assets")) }
}

/**
 * Another build: a copy of the package whose UI is built as `variant` (build.ts), its maps
 * kept apart. On macOS the copy's bundle is signed again, ad hoc.
 */
const variantBuild = (variant: Exclude<Variant, "production">): Build => {
  const app = packaged()
  const maps = join(output, "maps", variant)
  if (!buildUi(maps, variant)) throw new Error(`the UI's ${variant} build failed`)
  const copy = join(output, "apps", variant)
  rmSync(copy, { recursive: true, force: true })
  const bundle = join(copy, relative(join(app.bundle, ".."), app.bundle))
  cpSync(app.bundle, bundle, { recursive: true, verbatimSymlinks: true })
  const at = (path: string) => join(bundle, relative(app.bundle, path))
  const ui = join(at(app.resources), "ui")
  rmSync(ui, { recursive: true, force: true })
  cpSync(maps, ui, { recursive: true, filter: (source) => !source.endsWith(".map") })
  if (process.platform === "darwin")
    execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle], { stdio: "ignore" })
  return { executable: at(app.executable), attribution: sourceMapped(join(maps, "assets")) }
}

/** The trace's own record of the machine: CPU, GPU and OS, as Chromium saw them. */
const traceMachine = (metadata: unknown): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries((metadata ?? {}) as Record<string, unknown>).filter(([key]) =>
      /^(cpu-|gpu-|os-|product-version$|highres-ticks$|v8-version$)/.test(key),
    ),
  )

const gzip = async (file: string) => {
  await pipeline(createReadStream(file), createGzip(), createWriteStream(`${file}.gz`))
  rmSync(file)
}

/** Reads each phase's trace into its numbers, then gzips the trace. */
const analyze = async (
  recorded: readonly Recorded[],
  attribution: Attribution,
  seen: { metadata?: Record<string, unknown> },
): Promise<PhaseResult[]> => {
  const results: PhaseResult[] = []
  for (const one of recorded) {
    const common = {
      phase: one.phase,
      trace: relative(output, `${one.trace}.gz`),
      ...pageNumbers(one.frameGaps, one.longTasks),
      switches: one.switches,
      visible: one.visible,
      focused: one.focused,
    }
    try {
      const parsed = JSON.parse(readFileSync(one.trace, "utf8")) as {
        traceEvents?: TraceEvent[]
        metadata?: unknown
      }
      seen.metadata ??= traceMachine(parsed.metadata)
      results.push({ ...common, breakdown: breakdown(parsed.traceEvents ?? [], attribution) })
    } catch (cause) {
      results.push({ ...common, traceError: describe(cause) })
    }
    // eslint-disable-next-line no-await-in-loop -- One trace in memory at a time.
    await gzip(one.trace)
  }
  return results
}

const startedAt = new Date().toISOString()
const results: RunResult[] = []
const problems: string[] = []
let machine: Machine | undefined
// Whether `machine` is a finished run's reading, not a launch's.
let machineRead = false
const seen: { metadata?: Record<string, unknown> } = {}
let current: AppRun | undefined
let stoppedBy: string | undefined

/** Writes the report, `complete` once the last run is done, and says so on the last. */
const write = (complete: boolean) => {
  const summary = summarize(results)
  // A software rasterizer drawing, or no GPU compositing at all.
  const software =
    /llvmpipe|swiftshader|softpipe|basic render/i.test(
      JSON.stringify([seen.metadata?.["gpu-gl-renderer"], machine?.gpu]),
    ) || (machine?.gpuFeatures.gpu_compositing ?? "").startsWith("disabled")
  const report = {
    version: 1,
    complete,
    startedAt,
    finishedAt: new Date().toISOString(),
    commit,
    note: values.note,
    machine: {
      name: machineName,
      os: `${system()} ${release()}`,
      arch: process.arch,
      cpu: cpus()[0]?.model ?? "unknown",
      cpus: cpus().length,
      memoryGB: Math.round(totalmem() / 1024 ** 3),
      softwareRendering: software,
      chromium: seen.metadata,
      electron: machine,
    },
    scenarios: Object.fromEntries(chosen.map((name) => [name, scenarios[name]])),
    variants,
    shared,
    traceConfig,
    summary,
    throttled: throttledPhases(results),
    profilingOverhead: {
      busyShare: compared(summary, "profiling"),
      busyMsPerFrame: compared(summary, "profiling", "busyMsPerFrame"),
    },
    webgl: {
      busyShare: compared(summary, "webgl"),
      busyMsPerFrame: compared(summary, "webgl", "busyMsPerFrame"),
    },
    runs: results,
    problems,
    ...(stoppedBy && { error: `stopped by ${stoppedBy}` }),
  }
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, "profile.json"), `${JSON.stringify(report, null, 2)}\n`)
  const display = machine?.displays.find((each) => each.primary)
  const lines = [
    `${startedAt}${commit ? `, commit ${commit.slice(0, 12)}` : ""}${values.note ? `: ${values.note}` : ""}.`,
    "",
    ...(stoppedBy
      ? [`**Stopped by ${stoppedBy}: the runs it got before it stopped.**`, ""]
      : complete
        ? []
        : ["**In progress: the runs so far, written after each.**", ""]),
    ...(software
      ? ["**Software rendering: a smoke test of the tooling, not the baseline.**", ""]
      : []),
    `- CPU: ${report.machine.cpu} (${report.machine.cpus} threads), ${report.machine.memoryGB} GB, ${report.machine.os}`,
    `- GPU: ${String(seen.metadata?.["gpu-gl-renderer"] ?? "unknown")}; GPU compositing ${machine?.gpuFeatures.gpu_compositing ?? "unknown"}`,
    `- Display: ${display ? `${display.size.width}×${display.size.height} at ${display.scaleFactor}×, ${display.frequency || "?"} Hz` : "unknown"}; window ${machine?.window.width ?? "?"}×${machine?.window.height ?? "?"}`,
    `- Runs: ${runs} of each scenario on each build (${variants.join(", ")}); cells are the median (min–max) across runs; shares are of the phase's window unless they say "of busy".`,
    ...(throttledPhases(results).length > 0
      ? [
          "",
          `**Throttled, left out:** phases whose compositor drew under ${throttledFps} frames a second, as Chromium draws a page whose screen has gone dark (the desktop's idle blanking or a lock does it), measure the throttling, not the app. Their numbers are left out, and their runs out of the triggers:`,
          ...throttledPhases(results).map((one) => `- ${one}`),
        ]
      : []),
    ...(problems.length > 0 || results.some((run) => run.error)
      ? [
          "",
          "**Problems:**",
          ...problems.map((one) => `- ${one}`),
          ...results.flatMap((run) =>
            run.error
              ? [`- ${run.scenario}, ${run.variant}, run ${run.run}: ${run.error.split("\n")[0]}`]
              : [],
          ),
        ]
      : []),
  ]
  writeFileSync(
    join(output, "profile.md"),
    markdown(summary, { title: `Real-hardware profile: ${machineName}`, lines }),
  )
  if (complete)
    console.log(
      JSON.stringify(
        { output, problems, failed: results.filter((run) => run.error).length },
        null,
        2,
      ),
    )
}

// Stopped from outside: the app running closes, which ends its run, and the loop below
// keeps what the run got and writes it all out. A second signal ends at once.
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    if (stoppedBy) process.exit(1)
    stoppedBy = signal
    void current?.stop()
  })

if (process.platform === "win32") throw new Error("the profile needs Linux or macOS")
rmSync(traces, { recursive: true, force: true })
mkdirSync(traces, { recursive: true })
const builds: Partial<Record<Variant, Build>> = {}
if (variants.includes("production")) {
  const { problem, ...build } = production()
  if (problem) problems.push(problem)
  builds.production = build
}
for (const variant of variants)
  if (variant !== "production")
    try {
      builds[variant] = variantBuild(variant)
    } catch (cause) {
      problems.push(`no ${variant} build: ${describe(cause)}`)
    }
for (let run = 1; run <= runs; run += 1)
  for (const scenario of chosen)
    for (const variant of variants) {
      const build = builds[variant]
      if (stoppedBy || !build) continue
      const recorded: Recorded[] = []
      const agentPhases: (string | null)[] = []
      let error: string | undefined
      let leaked: readonly string[] = []
      try {
        const appRun = openApp(build.executable)
        current = appRun
        try {
          // eslint-disable-next-line no-await-in-loop -- One run at a time, alone on the machine.
          const opened = await appRun.start(shared.window, values.switch ?? [])
          machine ??= opened.machine
          // eslint-disable-next-line no-await-in-loop -- As above.
          await play(
            opened,
            scenario,
            join(traces, `${scenario}-${variant}-${run}`),
            recorded,
            agentPhases,
            variant === "webgl",
          )
          // The GPU status right after a launch may be from before the GPU process came up:
          // the first run to finish that can read it records the one it ran with.
          if (!machineRead)
            try {
              // eslint-disable-next-line no-await-in-loop -- As above.
              machine = await opened.readMachine()
              machineRead = true
            } catch {
              // The next run reads it again.
            }
        } catch (cause) {
          error = describe(cause)
        }
        // eslint-disable-next-line no-await-in-loop -- As above.
        leaked = await appRun
          .stop()
          .catch((cause: unknown) => [`stopping failed: ${describe(cause)}`])
      } catch (cause) {
        // The sandbox couldn't be made.
        error = describe(cause)
      }
      current = undefined
      problems.push(...leaked.map((one) => `${scenario}, ${variant}, run ${run}: ${one}`))
      results.push({
        scenario,
        variant,
        run,
        agentPhases,
        attributed: build.attribution !== none,
        // eslint-disable-next-line no-await-in-loop -- As above.
        phases: await analyze(recorded, build.attribution, seen),
        problems: leaked,
        ...(error !== undefined && {
          error: stoppedBy ? `stopped by ${stoppedBy}: ${error}` : error,
        }),
      })
      // A trace that can't be read leaves its phase's numbers out, which the summary can't tell.
      for (const one of results.at(-1)!.phases)
        if (one.traceError)
          problems.push(
            `${scenario}, ${variant}, run ${run}: the ${one.phase} trace couldn't be read: ${one.traceError.split("\n")[0]}`,
          )
      console.log(`${scenario}, ${variant}, run ${run}: ${error ? "failed" : "done"}`)
      // What the runs so far got, should a later one end it all.
      write(false)
    }
// The builds' copies of the package are big, and made again each time.
rmSync(join(output, "apps"), { recursive: true, force: true })
// A profile stopped from outside didn't do all its runs.
write(!stoppedBy)
process.exitCode = stoppedBy || problems.length > 0 || results.some((run) => run.error) ? 1 : 0
