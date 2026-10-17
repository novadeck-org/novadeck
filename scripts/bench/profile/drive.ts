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

// The profile's scenarios, each the timing run's (see ../timing/drive.ts) in the desktop
// app: 13 terminals, Grid then Focus on agent 1, a steady window in each after a warm-up,
// then the same switches in Focus. The timing scenario has 5 agents busy and the rest idle
// shells, as the timing run; the heavy one has all 13 busy, as the product's case is many
// agents. Each phase is recorded as a Chromium trace of its own, from the app's every
// process, between the page's `profile-start` and `profile-end` marks.

export const scenarios = {
  timing: { terminals: timing.terminals, agents: timing.agents },
  heavy: { terminals: timing.terminals, agents: timing.terminals },
} as const

export type ScenarioName = keyof typeof scenarios

export const shared = {
  warmMs: timing.warmMs,
  windowMs: timing.windowMs,
  switchPasses: timing.switchPasses,
  switchTargets: timing.switchTargets,
  window: timing.viewport,
} as const

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

/**
 * Plays `name` in the opened app, saving each phase's trace as `<prefix>-<phase>.json` and
 * adding what it recorded to `recorded` as it goes, so a run that fails part way keeps what
 * it got. `agentPhases` gets the agents' rows' phases once they are busy. With `webgl`, the
 * screens must draw on the WebGL renderer's canvases, as the DOM renderer draws none.
 */
export const play = async (
  opened: OpenedApp,
  name: ScenarioName,
  prefix: string,
  recorded: Recorded[],
  agentPhases: (string | null)[],
  webgl = false,
): Promise<void> => {
  const { app, page } = opened
  const { terminals, agents } = scenarios[name]
  await page.evaluate(probe)
  await boot(page)
  await layout(page, "Focus")
  await setUp(page, terminals, (n) => (n <= agents ? opened.agent(n) : idleShell(n)))
  // The WebGL renderer draws on a canvas of its own in the screen; the DOM renderer's only
  // canvas is the overview ruler's, outside it.
  if (
    webgl &&
    !(await page.evaluate(() => document.querySelector(".xterm-screen canvas") !== null))
  )
    throw new Error("the screens didn't load xterm's WebGL renderer")
  // A screen whose WebGL context the GPU process took back draws nothing, and its phase
  // measures less than the scenario.
  const lost = async () => {
    if (
      webgl &&
      (await page.evaluate(() => document.querySelector("[data-profile-webgl-lost]") !== null))
    )
      throw new Error("a screen lost its WebGL context")
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
    const written = await app.evaluate(
      ({ contentTracing }, path) => contentTracing.stopRecording(path),
      join(opened.scratch, `${phase}.json`),
    )
    const trace = `${prefix}-${phase}.json`
    copyFileSync(written, trace)
    rmSync(written, { force: true })
    await lost()
    recorded.push({ phase, trace, ...frames, switches, ...state })
  }

  await layout(page, "Grid")
  await sleep(shared.warmMs)
  await traced("grid", async () => {
    await sleep(shared.windowMs)
    return []
  })
  // What a person watching an agent sees, the others running beside it.
  await layout(page, "Focus")
  await select(page, 1)
  await sleep(shared.warmMs)
  await traced("focus", async () => {
    await sleep(shared.windowMs)
    return []
  })
  await traced("switches", async () => {
    const switches: Switch[] = []
    for (let pass = 0; pass < shared.switchPasses; pass += 1)
      for (const target of shared.switchTargets)
        // eslint-disable-next-line no-await-in-loop -- One switch after another.
        switches.push(await switchTo(page, target))
    return switches
  })
  for (let seed = 1; seed <= agents; seed += 1) opened.busy(seed, false)
}
