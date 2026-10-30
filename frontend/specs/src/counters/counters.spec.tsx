import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { vi } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { commands, server } from "vitest/browser"

import { chooseView, layoutSettled } from "../support/workspace"
import { describe, expect, it } from "../test"
import { startClock } from "./clock"
import { countNotifications, counts, observeMutations } from "./probes"
import { playScript } from "./script"

// React reports commits to a DevTools hook only if one is there before react-dom loads.
await vi.hoisted(async () => (await import("./probes")).installRenderCount())

// Where the run leaves its reading, for the gate and for comparing runs.
const readingPath = `${server.config.root}/test-results/counters.json`

// Fonts load in real time; loaded first, terminals measure their cells the same way
// every run.
const loadFonts = async (): Promise<void> => {
  await Promise.all([...document.fonts].map((face) => face.load().catch(() => undefined)))
  await document.fonts.ready
}

// Closes the app and its connection on the real clock, and waits until the runner has let
// go of it: closing waits up to 2 s for the last saves first.
const close = async (
  runner: ReturnType<typeof scriptedRunner>,
  connection: { readonly close: () => void },
): Promise<void> => {
  await cleanup()
  connection.close()
  await expect.poll(() => runner.connected()).toBe(false)
}

// The views' code loads when a view first shows, in real time. A warm-up on the real clock
// shows each view the script does, so in the run their code is there at once, whatever the
// machine's speed. Then it all goes, still on the real clock: its terminals close, so their
// screens and streams go, then the app and its connection; and the timers they leave run
// out (a screen parks 5 s after it was last shown). One outlasts the wait: boot progress's
// 15 s cap, which by then finds its boot long done and does nothing.
const leftoverMs = 6_000
const warmUp = async (): Promise<void> => {
  const runner = scriptedRunner({ terminals: 13 })
  const connection = await runner.connect(new AbortController().signal, pageTheme)
  await render(<App createBackend={connection.createBackend} />)
  await layoutSettled()
  await chooseView("Focus")
  runner.closeAll()
  await expect.poll(() => runner.streaming()).toBe(0)
  await close(runner, connection)
  await new Promise((resolve) => setTimeout(resolve, leftoverMs))
  expect(runner.unscripted()).toEqual([])
  localStorage.clear()
  sessionStorage.clear()
  window.history.replaceState(null, "", "/")
}

describe("Counter run", () => {
  it("counts what 13 busy agents cost the UI", async () => {
    await loadFonts()
    await warmUp()
    const stopNotifications = countNotifications()
    const runner = scriptedRunner({ terminals: 13 })
    const stopMutations = observeMutations()
    const clock = startClock(() => counts.commits + counts.mutations)
    let connection: Awaited<ReturnType<typeof runner.connect>> | undefined
    try {
      // The app connects and loads the workspace on the clock, as everything after does.
      connection = await clock.until(runner.connect(new AbortController().signal, pageTheme))
      // Rendering takes its own `act`; the clock's frames then let the app settle.
      await render(<App createBackend={connection.createBackend} />)
      await clock.frames(60)
      const names = runner.terminalIds.map((_, index) => `Agent ${index + 1}`)
      const reading = await playScript(runner, clock, { terminalNames: names })
      await commands.writeFile(readingPath, `${JSON.stringify(reading, null, 2)}\n`)
      // Every probe heard something in every phase: one that went dead, as when the code it
      // hooks moves, fails here rather than passing under budget.
      for (const phase of Object.values(reading)) {
        expect(phase.tickTotals.notifications).toBeGreaterThan(0)
        expect(phase.tickTotals.mutations).toBeGreaterThan(0)
        expect(phase.tickTotals.renders).toBeGreaterThan(0)
      }
      // Grid shows every terminal, so every one streams and all their output arrives.
      expect(reading.grid.streamingSettled).toBe(13)
      expect(reading.grid.bytes).toBe(reading.grid.written)
      // Focus parks what it doesn't show, so most of the output never arrives.
      expect(reading.focus.bytes).toBeLessThan(reading.focus.written)
    } finally {
      stopMutations()
      stopNotifications()
      clock.stop()
      // Soft, so a run that already failed still reports its own failure.
      const closing =
        connection &&
        (await close(runner, connection).then(
          () => undefined,
          (error: unknown) => error,
        ))
      expect.soft(closing, "closing the app and its connection").toBeUndefined()
      // The app called nothing the script doesn't play, the run failing or not.
      expect.soft(runner.unscripted()).toEqual([])
    }
  })
})
