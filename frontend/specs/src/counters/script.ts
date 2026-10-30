import type { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { expect } from "vitest"

import { terminalTab, view, viewSwitcher } from "../support/workspace"
import { frameMs, type Clock } from "./clock"
import { counts, type Counts } from "./probes"

// The counter run's fixed script: 13 agents' terminals in Grid, then Focus, then switches
// between them in Focus. Each phase plays rounds of status-line ticks, one terminal at a
// time, and of output to every terminal, then waits out the park timer.

type Runner = ReturnType<typeof scriptedRunner>

// What one phase counted: its telemetry ticks, and what they cost in total.
export type PhaseReading = {
  readonly ticks: number
  readonly tickTotals: Counts
  // Bytes the terminals' streams handed the UI over the whole phase, snapshots included,
  // and the bytes their programs wrote.
  readonly bytes: number
  readonly written: number
  // Streams attached at once: the most at any step, and once the phase has settled.
  readonly streamingPeak: number
  readonly streamingSettled: number
}

export type Reading = Readonly<Record<"grid" | "focus" | "switches", PhaseReading>>

// Rounds of ticks and output per phase, and how long the script waits for screens to
// park: past the 5 s a screen nobody shows keeps streaming before it parks, in steps of a
// half second, each checking how many stream.
const rounds = 3
const parkFrames = Math.ceil(6_000 / frameMs)
const checkFrames = Math.ceil(500 / frameMs)

type Summary = Parameters<Parameters<Runner["report"]>[1]>[0]

const tickTelemetry = (round: number) => (summary: Summary) => ({
  telemetry: {
    ...summary.telemetry!,
    context: { occupied: (round + 1) * 1_000, capacity: 200_000 },
  },
})

// One line of an agent's output, coloured as agents print theirs.
const line = (terminal: number, round: number): string =>
  `\u001b[32m●\u001b[0m Agent ${terminal + 1} step ${round + 1}: reading files and editing code\r\n`

export const playScript = async (
  runner: Runner,
  clock: Clock,
  { terminalNames }: { readonly terminalNames: readonly string[] },
): Promise<Reading> => {
  const tick: Counts = { wakes: 0, mutations: 0, commits: 0, renders: 0 }
  let ticks = 0
  let bytesAt = runner.bytes()
  let writtenAt = runner.written()
  let streamingPeak = 0
  const reset = (): void => {
    for (const key of Object.keys(tick) as (keyof Counts)[]) tick[key] = 0
    ticks = 0
    bytesAt = runner.bytes()
    writtenAt = runner.written()
    streamingPeak = runner.streaming()
  }
  const step = async (action: () => unknown, frames?: number): Promise<void> => {
    await clock.step(action, frames)
    streamingPeak = Math.max(streamingPeak, runner.streaming())
  }
  // A telemetry tick, counted on its own.
  const telemetryTick = async (terminalId: string, round: number): Promise<void> => {
    const before = { ...counts }
    await step(() => runner.report(terminalId, tickTelemetry(round)))
    for (const key of Object.keys(tick) as (keyof Counts)[]) tick[key] += counts[key] - before[key]
    ticks += 1
  }
  const play = async (): Promise<void> => {
    for (let round = 0; round < rounds; round += 1) {
      for (const terminalId of runner.terminalIds)
        // eslint-disable-next-line no-await-in-loop -- The script plays in order.
        await telemetryTick(terminalId, round)
      // eslint-disable-next-line no-await-in-loop -- The script plays in order.
      await step(() =>
        runner.terminalIds.forEach((terminalId, index) =>
          runner.write(terminalId, line(index, round)),
        ),
      )
    }
  }
  const waitForParking = async (): Promise<void> => {
    for (let waited = 0; waited < parkFrames; waited += checkFrames) {
      // eslint-disable-next-line no-await-in-loop -- The clock moves in order.
      await clock.frames(checkFrames)
      streamingPeak = Math.max(streamingPeak, runner.streaming())
    }
  }
  const reading = async (): Promise<PhaseReading> => {
    await waitForParking()
    return {
      ticks,
      tickTotals: { ...tick },
      bytes: runner.bytes() - bytesAt,
      written: runner.written() - writtenAt,
      streamingPeak,
      streamingSettled: runner.streaming(),
    }
  }

  // Each action is checked to have landed: one that missed would count the wrong thing
  // the same way every run.
  expect(view("Grid").element()).toBeChecked()
  reset()
  await play()
  const grid = await reading()

  // Focus is measured as it stays: once the terminals it doesn't show have parked.
  await step(() => viewSwitcher().getByText("Focus", { exact: true }).click(), 10)
  expect(view("Focus").element()).toBeChecked()
  await waitForParking()
  reset()
  await play()
  const focus = await reading()

  reset()
  for (const name of [...terminalNames.slice(1), terminalNames[0]!]) {
    // eslint-disable-next-line no-await-in-loop -- The script plays in order.
    await step(() => terminalTab(name).click(), 10)
    expect(terminalTab(name).element()).toHaveAttribute("aria-current", "true")
    const index = terminalNames.indexOf(name)
    // eslint-disable-next-line no-await-in-loop -- The script plays in order.
    await telemetryTick(runner.terminalIds[index]!, rounds)
    // Every agent writes on, shown or not.
    // eslint-disable-next-line no-await-in-loop -- The script plays in order.
    await step(() =>
      runner.terminalIds.forEach((terminalId, other) =>
        runner.write(terminalId, line(other, rounds + index)),
      ),
    )
  }
  const switches = await reading()

  return { grid, focus, switches }
}
