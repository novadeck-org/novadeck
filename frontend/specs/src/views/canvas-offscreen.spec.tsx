import { scriptedRunner } from "@novadeck/runner-adapter/scripted-server"
import { App } from "@novadeck/ui/app/App"
import { pageTheme } from "@novadeck/ui/theme/source"
import { onTestFinished } from "vitest"
import { cleanup, render } from "vitest-browser-react"
import { page } from "vitest/browser"

import { boxOf, dragBackground, settled, viewBox } from "../support/canvas"
import { layoutSettled, terminal, terminalTab } from "../support/workspace"
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

// Opens Canvas over two agents: "Agent 1" in view, and "Agent 2" with its left edge at
// `secondX`, by default past the right edge by more than the margin Canvas watches beyond
// its edges.
const openCanvas = async (secondX = window.innerWidth * 2.5 + 700) => {
  const [first, second] = scriptedRunner({ terminals: 2 }).terminalIds as [string, string]
  const runner = scriptedRunner({
    terminals: 2,
    canvas: {
      viewport: { x: 0, y: 0, zoom: 1 },
      geometry: {
        [first]: {
          position: { x: 20, y: 20 },
          width: 320,
          height: 240,
        },
        [second]: {
          position: { x: secondX, y: 20 },
          width: 320,
          height: 240,
        },
      },
    },
  })
  const connection = await runner.connect(new AbortController().signal, pageTheme)
  onTestFinished(async () => {
    await cleanup()
    connection.close()
    await expect.poll(() => runner.connected()).toBe(false)
  })
  await render(<App createBackend={connection.createBackend} />)
  await layoutSettled()
  return runner
}

/** Drags the camera left by about a screen, leaving the Canvas bare under the pointer. */
const panLeft = async (): Promise<void> => {
  const { width } = viewBox()
  await dragBackground({ x: width - 10, y: viewBox().height - 10 }, { x: 40 - width, y: 0 })
}

describe("Canvas out of sight", () => {
  it("opens no screen for a node that has never been in sight", async () => {
    const runner = await openCanvas()
    await expect.poll(() => runner.attaches()).toBe(1)
    await expect.poll(() => hidden(runner.terminalIds[1]!), parkedWithin).toBe(true)
    // Nothing opened for it while it waited, and its neighbour in sight is not hidden.
    expect(runner.attaches()).toBe(1)
    expect(runner.streaming()).toBe(1)
    expect(hidden(runner.terminalIds[0]!)).toBe(false)
  }, 30_000)

  it("hides a node panned out of sight, and shows and opens it again panned back", async () => {
    const runner = await openCanvas()
    const [first, second] = runner.terminalIds as [string, string]
    await expect.element(terminal("Agent 1")).toBeVisible()
    await expect.poll(() => runner.streaming()).toBe(1)
    expect(runner.attaches()).toBe(1)
    // xterm's rows hold no-break spaces, so the output is matched across any whitespace.
    runner.write(first, "output before leaving\r\n")
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)

    // The second node, never in sight, is hidden until it is panned in; then it shows
    // before its screen opens.
    await expect.poll(() => hidden(second), parkedWithin).toBe(true)
    for (let pans = 0; pans < 6 && !hidden(first) && nodeBox(second).left > 0; pans++) {
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await panLeft()
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(second))
    }
    await expect.poll(() => hidden(second)).toBe(false)
    await expect.poll(() => runner.attaches()).toBe(2)

    // The first node is out of sight: its screen parks, then its content hides. Hiding
    // first would have xterm measure a node that is not laid out (the hide waits longer than
    // the park), so it is noted if the content is ever seen hidden with its screen open.
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
    for (let pans = 0; pans < 6 && nodeBox(first).left < 0; pans++) {
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await dragBackground({ x: 10, y: viewBox().height - 10 }, { x: viewBox().width - 40, y: 0 })
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(first))
    }
    await expect.poll(() => hidden(first)).toBe(false)
    await expect.poll(() => runner.attaches()).toBe(3)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+while\s+away/)
    await expect
      .poll(() => terminal("Agent 1").element().textContent)
      .toMatch(/output\s+before\s+leaving/)
  }, 60_000)

  it("opens the screen of a node just past the edge, within the margin", async () => {
    // 100 px past the right edge: in sight as far as Canvas is concerned.
    const runner = await openCanvas(window.innerWidth + 100)
    await expect.poll(() => runner.attaches(), { timeout: 5_000 }).toBe(2)
    expect(hidden(runner.terminalIds[1]!)).toBe(false)
  }, 30_000)

  it("gives keyboard focus sent to a hidden node to its input once it is back", async () => {
    const runner = await openCanvas()
    const [first, second] = runner.terminalIds as [string, string]
    await expect.poll(() => runner.streaming()).toBe(1)
    for (let pans = 0; pans < 6 && nodeBox(second).left > 0; pans++) {
      // eslint-disable-next-line no-await-in-loop -- One pan after another.
      await panLeft()
      // eslint-disable-next-line no-await-in-loop -- The camera settles before the next.
      await settled(() => nodeBox(second))
    }
    await expect.poll(() => runner.attaches()).toBe(2)
    await expect.poll(() => hidden(first), parkedWithin).toBe(true)

    // The tab brings the camera to the node and asks for its input in the same moment; the
    // request waits for the node to be back, not spent on the screen it let go.
    await terminalTab("Agent 1").click()
    await expect.poll(() => runner.attaches()).toBe(3)
    await expect
      .poll(() => {
        const input = document.querySelector(`[data-node="${first}"] textarea`)
        return input !== null && document.activeElement === input
      })
      .toBe(true)
  }, 60_000)
})
