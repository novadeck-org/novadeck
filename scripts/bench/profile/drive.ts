import { copyFileSync, rmSync } from "node:fs"
import { join } from "node:path"

import {
  boot,
  idleShell,
  layout,
  phase as rowPhase,
  probe,
  scenario as timing,
  select,
  setUp,
  sleep,
  startRecording,
  stopRecording,
  switchTo,
  until,
} from "../timing/drive.ts"
import type { Switch } from "../timing/report.ts"
import type { OpenedApp } from "./app.ts"
import { readGl, type GlReport } from "./gpu.ts"
import { sampleMemory, type MemoryPoint, type MemorySample } from "./memory.ts"

// The profile's scenarios, each the timing run's (see ../timing/drive.ts) in the desktop
// app: 13 terminals by default, Grid then Focus on agent 1, a steady window in each after a
// warm-up, then the same switches in Focus. The timing scenario has 5 agents busy and the rest
// idle shells, as the timing run; the heavy one has all of them busy, as the product's case is
// many agents. `--terminals` sets how many. Each phase is recorded as a Chromium trace of its
// own, from the app's every process, between the page's `profile-start` and `profile-end`
// marks, and the memory is sampled outside them (memory.ts).

export const defaultTerminals = timing.terminals

export const scenarioNames = ["timing", "heavy"] as const

export type ScenarioName = (typeof scenarioNames)[number]

/** `name` with `terminals` terminals, the first of them running agents. */
export const scenarioFor = (name: ScenarioName, terminals: number) => ({
  terminals,
  agents: name === "heavy" ? terminals : Math.min(timing.agents, terminals),
})

export const shared = {
  warmMs: timing.warmMs,
  windowMs: timing.windowMs,
  switchPasses: timing.switchPasses,
  window: timing.viewport,
} as const

/**
 * The terminals the switches phase presses: the timing run's, those the session has (it names
 * the first 13, whichever the count, so the switches stay the same across counts).
 */
export const switchTargetsFor = (terminals: number): readonly number[] =>
  timing.switchTargets.filter((target) => target <= terminals)

export type PhaseName = "grid" | "focus" | "switches"

/** What one phase recorded in the page, and where its trace was saved. */
export type Recorded = {
  readonly phase: PhaseName
  readonly trace: string
  readonly frameGaps: readonly number[]
  readonly longTasks: readonly number[]
  readonly switches: readonly Switch[]
  /** Whether the page was shown and focused at the phase's end, as a throttled one isn't. */
  readonly visible: boolean
  readonly focused: boolean
  /** The page's screens at the phase's end: mounted, in view, with a WebGL context. */
  readonly gl: GlReport
}

// What the traces record: the timeline DevTools shows, frames, and V8's CPU samples.
export const traceConfig: Electron.TraceConfig = {
  recording_mode: "record-until-full",
  trace_buffer_size_in_kb: 1024 * 1024,
  included_categories: [
    "__metadata",
    "toplevel",
    "devtools.timeline",
    "disabled-by-default-devtools.timeline",
    "disabled-by-default-devtools.timeline.frame",
    "blink.user_timing",
    "v8.execute",
    "disabled-by-default-v8.cpu_profiler",
  ],
}

/** What a run is set to do besides its scenario. */
export type Options = {
  /** Terminals the session opens. */
  readonly terminals: number
  /**
   * Whether the page's pool and Chromium's cap are raised (`--contexts`): then no screen may
   * lose its context, and the run fails should one.
   */
  readonly raisedCap: boolean
}

/**
 * Plays `name` in the opened app, saving each phase's trace as `<prefix>-<phase>.json` and
 * adding what it recorded to `recorded` as it goes, so a run that fails part way keeps what
 * it got. `agentPhases` gets the agents' rows' phases once they are busy, and `memory` the
 * memory sampled at the start and after each phase.
 */
export const play = async (
  opened: OpenedApp,
  name: ScenarioName,
  prefix: string,
  recorded: Recorded[],
  agentPhases: (string | null)[],
  memory: MemorySample[],
  options: Options,
): Promise<void> => {
  const { app, page } = opened
  const { terminals, agents } = scenarioFor(name, options.terminals)
  await page.evaluate(probe)
  await boot(page)
  await layout(page, "Focus")
  memory.push(await sampleMemory(opened, "boot", 0))
  await setUp(page, terminals, (n) => (n <= agents ? opened.agent(n) : idleShell(n)))
  // A screen whose WebGL context the GPU process took back draws nothing, and its phase
  // measures less than the scenario. Past Chromium's default of 16, with the cap raised,
  // none may go: that is what the raised cap is for.
  const lost = (gl: GlReport) => {
    if (options.raisedCap && (gl.contextLost > 0 || (gl.lostEvents ?? 0) > 0))
      throw new Error(
        `${gl.contextLost} screens hold a lost WebGL context, ${gl.lostEvents} contexts were lost, with ${gl.withContext} of ${gl.mounted} screens holding one`,
      )
  }
  for (let seed = 1; seed <= agents; seed += 1) opened.busy(seed, true)
  const seeds = Array.from({ length: agents }, (_, index) => index + 1)
  const phases = () => Promise.all(seeds.map((n) => rowPhase(page, n)))
  await until(async () => (await phases()).every((each) => each === "running"), 15_000)
  agentPhases.push(...(await phases()))

  const traced = async (phase: PhaseName, during: () => Promise<readonly Switch[]>) => {
    await app.evaluate(
      ({ contentTracing }, config) => contentTracing.startRecording(config),
      traceConfig,
    )
    // Tracing settles in every process before the window opens.
    await sleep(500)
    const from = await startRecording(page)
    await page.evaluate(() => performance.mark("profile-start"))
    const switches = await during()
    await page.evaluate(() => performance.mark("profile-end"))
    const frames = await stopRecording(page, from)
    const state = await page.evaluate(() => ({
      visible: document.visibilityState === "visible",
      focused: document.hasFocus(),
    }))
    const gl = await readGl(page)
    const written = await app.evaluate(
      ({ contentTracing }, path) => contentTracing.stopRecording(path),
      join(opened.scratch, `${phase}.json`),
    )
    const trace = `${prefix}-${phase}.json`
    copyFileSync(written, trace)
    rmSync(written, { force: true })
    recorded.push({ phase, trace, ...frames, switches, ...state, gl })
    lost(gl)
  }
  // Memory is read outside the phases, as its dumps would load their main thread.
  const sampled = async (point: MemoryPoint) => {
    const sample = await sampleMemory(opened, point, terminals)
    memory.push(sample)
    lost(sample.gl)
  }

  await layout(page, "Grid")
  await sleep(shared.warmMs)
  await traced("grid", async () => {
    await sleep(shared.windowMs)
    return []
  })
  await sampled("grid")
  // What a person watching an agent sees, the others running beside it.
  await layout(page, "Focus")
  await select(page, 1)
  await sleep(shared.warmMs)
  await traced("focus", async () => {
    await sleep(shared.windowMs)
    return []
  })
  await sampled("focus")
  await traced("switches", async () => {
    const switches: Switch[] = []
    for (let pass = 0; pass < shared.switchPasses; pass += 1)
      for (const target of switchTargetsFor(terminals))
        // eslint-disable-next-line no-await-in-loop -- One switch after another.
        switches.push(await switchTo(page, target))
    return switches
  })
  await sampled("switches")
  for (let seed = 1; seed <= agents; seed += 1) opened.busy(seed, false)
}
