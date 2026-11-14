import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { boxOf, dragBackground, settled, viewBox } from "../support/canvas"
import { chooseView, terminal, terminalTab } from "../support/workspace"
import { describe, expect, it } from "../test"

// Canvas keeps what is out of the person's sight from streaming and laying out (performance
// rule 13). It runs over a scripted runner, whose streams tell which terminals' screens are
// open. A screen parks 5 s after its last surface lets go, and Canvas hides the node a
// moment after that, so these specs wait in real time.
const parkedWithin = { timeout: 12_000 }

// The node's content, hidden once its node is out of sight and its screen has parked: marked,
// and not laid out.
const hidden = (id: string): boolean => {
  const content = document.querySelector(`[data-node="${id}"] [data-off-screen]`)
  return content !== null && getComputedStyle(content).contentVisibility === "hidden"
}

// Where a node is, hidden or not: its content leaves the accessibility tree while hidden, so
// the terminal's region cannot be found by its name then.
const nodeBox = (id: string) =>
  boxOf(page.elementLocator(document.querySelector(`[data-node="${id}"]`)!))

// Opens Canvas over two agents. Canvas arranges them itself and frames both, so both are in
// sight as it opens: "Agent 1" above "Agent 2", with the bare Canvas of a gutter on each side.
const openCanvas = async () => {
  const runner = scriptedRunner({ terminals: 2 })
  const connection = await runner.connect(new AbortController().signal, pageTheme)
  onTestFinished(async () => {
    await cleanup()
    connection.close()
    await expect.poll(() => runner.connected()).toBe(false)
  })
  await render(<App createBackend={connection.createBackend} />)
  await chooseView("Canvas")
  await expect.element(terminal("Agent 1")).toBeVisible()
  return runner
}

// How far past the view's edges Canvas still counts a node in sight (Canvas.tsx).
const margin = 400

/** Drags the camera up or down by `by` (at most a screen), from the bare gutter beside the windows. */
const pan = async (by: number): Promise<void> => {
  const { height } = viewBox()
  await dragBackground({ x: 20, y: by > 0 ? 10 : height - 10 }, { x: 0, y: by })
}

/** Pans up until the node's bottom is further above the view than the margin reaches. */
const panAbove = async (id: string): Promise<void> => {
  for (let pans = 0; pans < 6; pans++) {
    const box = nodeBox(id)
    if (box.top + box.height < -margin - 50) return
    // eslint-disable-next-line no-await-in-loop -- One pan after another.
    await pan(-Math.min(700, box.top + box.height + margin + 100))
    // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
    await settled(() => nodeBox(id))
  }
}

describe("Canvas out of sight", () => {
  it("opens a screen for every node in sight as it opens, and hides none", async () => {
    const runner = await openCanvas()
    // Nothing waits hidden, and every screen is open.
    await expect.poll(() => runner.streaming()).toBe(2)
    for (const id of runner.terminalIds) expect(hidden(id)).toBe(false)
  }, 30_000)

  it("hides a node panned out of sight, and shows and opens it again panned back", async () => {
    const runner = await openCanvas()
    const [first] = runner.terminalIds as [string, string]
    await expect.element(terminal("Agent 1")).toBeVisible()
    await expect.poll(() => runner.streaming()).toBe(2)
    const attached = await settled(() => runner.attaches())
    // xterm's rows hold no-break spaces, so the output is matched across any whitespace.
    runner.write(first, "output before leaving\r\n")
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)

    // The first node is out of sight: its screen parks, then its content hides. Hiding
    // first would have xterm measure a node that is not laid out (the hide waits longer than
    // the park), so it is noted if the content is ever seen hidden with its screen open.
    await panAbove(first)
    let hiddenBeforeParked = false
    await expect
      .poll(() => {
        if (hidden(first) && runner.streaming() !== 1) hiddenBeforeParked = true
        return hidden(first)
      }, parkedWithin)
      .toBe(true)
    expect(hiddenBeforeParked).toBe(false)
    expect(runner.streaming()).toBe(1)
    runner.write(first, "output while away\r\n")

    // Panned back, it shows, takes its screen again, and draws what it missed.
    for (let pans = 0; pans < 6 && nodeBox(first).top < 0; pans++) {
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await pan(Math.min(700, -nodeBox(first).top + 40))
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(first))
    }
    await expect.poll(() => hidden(first)).toBe(false)
    await expect.poll(() => runner.attaches()).toBe(attached + 1)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+while\s+away/)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)
  }, 60_000)

  it("opens the screen of a node just past the edge, within the margin", async () => {
    const runner = await openCanvas()
    const second = runner.terminalIds[1]!
    await expect.poll(() => runner.streaming()).toBe(2)
    const attached = await settled(() => runner.attaches())
    // Pan both far below the view's bottom edge, where Agent 2 parks and hides.
    for (let pans = 0; pans < 6 && nodeBox(second).top < viewBox().height + margin + 100; pans++) {
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await pan(700)
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(second))
    }
    await expect.poll(() => hidden(second), parkedWithin).toBe(true)

    // 150 px past the bottom edge: in sight as far as Canvas is concerned.
    for (let pans = 0; pans < 4; pans++) {
      const missing = Math.round(viewBox().height + 150 - nodeBox(second).top)
      if (Math.abs(missing) < 20) break
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await pan(Math.max(-700, Math.min(700, missing)))
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(second))
    }

    // Both are in sight again, Agent 1 as well, which had left with it: each opens its screen.
    await expect.poll(() => runner.streaming(), { timeout: 5_000 }).toBe(2)
    expect(runner.attaches()).toBeGreaterThan(attached)
    expect(hidden(second)).toBe(false)
  }, 60_000)

  it("gives keyboard focus sent to a hidden node to its input once it is back", async () => {
    const runner = await openCanvas()
    const [first] = runner.terminalIds as [string, string]
    await expect.poll(() => runner.streaming()).toBe(2)
    const attached = await settled(() => runner.attaches())
    await panAbove(first)
    await expect.poll(() => hidden(first), parkedWithin).toBe(true)

    // The tab brings the camera to the node and asks for its input in the same moment; the
    // request waits for the node to be back, not spent on the screen it let go.
    await terminalTab("Agent 1").click()
    await expect.poll(() => runner.attaches()).toBe(attached + 1)
    await expect
      .poll(() => {
        const input = document.querySelector(`[data-node="${first}"] textarea`)
        return input !== null && document.activeElement === input
      })
      .toBe(true)
  }, 60_000)
})
