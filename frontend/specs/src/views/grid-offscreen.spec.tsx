import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { chooseView, terminal } from "../support/workspace"
import { describe, expect, it } from "../test"

// Grid opens the screens of the tiles in sight, a few at a time, and keeps those scrolled far
// out of it from streaming and laying out (performance rule 13), as Canvas does
// (canvas-offscreen.spec.tsx). It runs over a scripted runner, whose streams tell how many
// terminals' screens are open. A screen parks 5 s after its last surface lets go, and Grid
// hides the tile a moment after that, so these specs wait in real time.
const parkedWithin = { timeout: 12_000 }

// How far past the stage's top and bottom Grid still counts a tile in sight (Grid.tsx).
const margin = 400

// Ten agents in two columns at 1440 by 900: five rows, about two of them in view.
const count = 10

const stage = (): HTMLElement => document.querySelector<HTMLElement>(".grid-stage")!
const tile = (id: string): HTMLElement =>
  document.querySelector<HTMLElement>(`[data-grid-terminal="${id}"]`)!

// The tile's content, hidden once it is out of sight and its screen has parked: marked, and
// not laid out.
const hidden = (id: string): boolean => {
  const content = tile(id).querySelector("[data-off-screen]")
  return content !== null && getComputedStyle(content).contentVisibility === "hidden"
}

// The tiles within the margin of the stage's view, as Grid counts them in sight.
const inSight = (ids: readonly string[]): string[] => {
  const view = stage().getBoundingClientRect()
  return ids.filter((id) => {
    const box = tile(id).getBoundingClientRect()
    return box.bottom > view.top - margin && box.top < view.bottom + margin
  })
}

const openGrid = async () => {
  await page.viewport(1440, 900)
  const runner = scriptedRunner({ terminals: count })
  const connection = await runner.connect(new AbortController().signal, pageTheme)
  onTestFinished(async () => {
    await cleanup()
    connection.close()
    await expect.poll(() => runner.connected()).toBe(false)
  })
  await render(<App createBackend={connection.createBackend} />)
  await chooseView("Grid")
  await expect.element(terminal("Agent 1")).toBeVisible()
  return runner
}

describe("Grid out of sight", () => {
  it("opens a screen for every tile in sight, and none for those far below", async () => {
    const runner = await openGrid()
    const near = inSight(runner.terminalIds)
    // The layout this spec relies on: some tiles are past the margin.
    expect(near.length).toBeGreaterThan(0)
    expect(near.length).toBeLessThan(count)
    await expect.poll(() => runner.streaming()).toBe(near.length)
    for (const id of runner.terminalIds) expect(hidden(id)).toBe(false)
  }, 30_000)

  it("hides a tile scrolled out of sight, and shows and opens it again scrolled back", async () => {
    const runner = await openGrid()
    const first = runner.terminalIds[0]!
    await expect.poll(() => runner.streaming()).toBe(inSight(runner.terminalIds).length)
    runner.write(first, "output before leaving\r\n")
    // xterm's rows hold no-break spaces, so the output is matched across any whitespace.
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)

    // Scrolled to the end, the first row is past the margin: its screens park, then its
    // content hides. Hiding first would have xterm measure a tile that is not laid out (the
    // hide waits longer than the park), so it is noted if the content is ever seen hidden
    // with its screen open.
    stage().scrollTop = stage().scrollHeight
    await expect.poll(() => inSight(runner.terminalIds).includes(first)).toBe(false)
    const near = inSight(runner.terminalIds)
    // The rows scrolled in open their screens; then those scrolled away park, 5 s after
    // they let them go.
    await expect.poll(() => runner.streaming()).toBeGreaterThan(near.length)
    await expect.poll(() => runner.streaming(), parkedWithin).toBe(near.length)
    let hiddenBeforeParked = false
    await expect
      .poll(() => {
        if (hidden(first) && runner.streaming() !== near.length) hiddenBeforeParked = true
        return hidden(first)
      }, parkedWithin)
      .toBe(true)
    expect(hiddenBeforeParked).toBe(false)
    const attached = runner.attaches()
    runner.write(first, "output while away\r\n")

    // Scrolled back, it shows, takes its screen again, and draws what it missed.
    stage().scrollTop = 0
    await expect.poll(() => hidden(first)).toBe(false)
    await expect.poll(() => runner.attaches()).toBeGreaterThan(attached)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+while\s+away/)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)
  }, 60_000)
})
