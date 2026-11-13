import { createView, type Terminal, type View } from "@novadeck/emulator/browser"
import { afterEach, describe as context, describe, expect, it, vi } from "vitest"

import {
  closeScreens,
  emulatorPrototype,
  optionsOf,
  output,
  screensOf,
  settled,
  shown,
  snapshot,
  streamOf,
} from "./fakes.test-support.js"
import { domPaceMs, paceFor, unseenPaceMs, type ShowOptions } from "./screens.js"

// jsdom has no layout observers, media queries or canvas; xterm falls back without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
})

afterEach(closeScreens)

const past = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// A terminal's screen over a stream the test feeds, recording in order what reaches the
// emulator: each write, and each resize. The write of `failing`, when given, fails as a buffer
// whose rows went missing does. The screen's renderer draws with WebGL while `webgl.on`, and
// `webgl.switch` tells it, as the page's pool does when it gives or takes a context.
const paced = (show: Partial<ShowOptions>, failing?: string) => {
  const calls: string[] = []
  const prototype = emulatorPrototype()
  const write = prototype.write
  const resize = prototype.resize
  vi.spyOn(prototype, "write").mockImplementation(function (
    this: Terminal,
    data: string | Uint8Array,
    callback?: () => void,
  ) {
    const text = String(data)
    if (text !== "\x18") calls.push(`write ${text}`)
    if (text === failing) {
      ;(callback as ((error?: unknown) => void) | undefined)?.(new Error("rows went missing"))
      return
    }
    write.call(this, data, callback)
  })
  vi.spyOn(prototype, "resize").mockImplementation(function (
    this: Terminal,
    cols: number,
    rows: number,
  ) {
    calls.push(`resize ${cols}x${rows}`)
    resize.call(this, cols, rows)
  })
  const webgl = { on: false, switch: () => {} }
  const streams = [streamOf([snapshot("$ ")]), streamOf([snapshot("$ again")])]
  let attaches = 0
  const screens = screensOf(
    optionsOf({
      attach: () => Promise.resolve(streams[Math.min(attaches++, 1)]!.attached),
      emulator: (container, open): View => {
        const view = createView(container, { ...open, scrollback: 0 })
        const listeners = new Set<() => void>()
        webgl.switch = () => listeners.forEach((listener) => listener())
        return {
          ...view,
          renderer: { ...view.renderer, drawn: () => webgl.on },
          onRendererChange: (listener) => {
            listeners.add(listener)
            return { dispose: () => void listeners.delete(listener) }
          },
        }
      },
    }),
  )
  const { hold } = shown(screens, "T", show)
  // What the stream sent after its first screen, as the emulator was given it.
  const drawn = () => calls.filter((call) => call !== "write $ ")
  return { calls, drawn, hold, stream: streams[0]!, attached: () => attaches, webgl }
}

// The first screen drawn and any fit done, so the test sees only what it sends.
const ready = async (screen: ReturnType<typeof paced>) => {
  await expect.poll(() => screen.calls.includes("write $ ")).toBe(true)
  await settled()
  screen.calls.length = 0
}

describe("how often a screen draws", () => {
  it("draws as output comes when selected, or drawn with WebGL, wherever it shows", () => {
    expect(paceFor({ selected: true, visible: true, webgl: false })).toBe(0)
    expect(paceFor({ selected: false, visible: true, webgl: true })).toBe(0)
  })

  it("draws a few times a second unselected on the DOM renderer, whose draws cost layout", () => {
    expect(paceFor({ selected: false, visible: true, webgl: false })).toBe(domPaceMs)
  })

  it("draws now and then where it can't be seen, selected or not", () => {
    for (const selected of [true, false])
      for (const webgl of [true, false])
        expect(paceFor({ selected, visible: false, webgl })).toBe(unseenPaceMs)
  })
})

describe("a paced screen", () => {
  context("unselected, on the DOM renderer", () => {
    it("draws what arrives within its pace in one write", async () => {
      const screen = paced({ selected: false })
      await ready(screen)
      screen.stream.push(output("one ", 2))
      screen.stream.push(output("two", 3))
      await settled()
      expect(screen.drawn()).toEqual([])
      await past(domPaceMs * 2)
      expect(screen.drawn()).toEqual(["write one two"])
    })

    it("draws what waits at once when selected", async () => {
      const screen = paced({ selected: false })
      await ready(screen)
      screen.stream.push(output("typed", 2))
      await settled()
      screen.hold.update({ selected: true })
      await expect.poll(screen.drawn, { timeout: domPaceMs / 2 }).toEqual(["write typed"])
      screen.stream.push(output(" and more", 3))
      await expect
        .poll(screen.drawn, { timeout: domPaceMs / 2 })
        .toEqual(["write typed", "write  and more"])
    })

    it("draws what waits at once when WebGL takes it over", async () => {
      const screen = paced({ selected: false })
      await ready(screen)
      screen.stream.push(output("drawn", 2))
      await settled()
      screen.webgl.on = true
      screen.webgl.switch()
      await expect.poll(screen.drawn, { timeout: domPaceMs / 2 }).toContain("write drawn")
    })

    it("resizes only after the output that came before the resize", async () => {
      const screen = paced({ selected: false })
      await ready(screen)
      screen.stream.push(output("\x1b[1;70HX", 2))
      screen.stream.push({ sequence: 3, type: "resized", cols: 40, rows: 24 })
      await expect
        .poll(screen.drawn, { timeout: domPaceMs * 2 })
        .toEqual(["write \x1b[1;70HX", "resize 40x24"])
    })

    it("draws a fresh screen at once, after what came before it", async () => {
      const screen = paced({ selected: false })
      await ready(screen)
      screen.stream.push(output("stale", 2))
      screen.stream.push(snapshot("$ fresh"))
      await expect
        .poll(() => screen.drawn().filter((call) => call.startsWith("write")), {
          timeout: domPaceMs / 2,
        })
        .toEqual(["write stale", "write $ fresh"])
    })

    it("draws its screen afresh after a write that failed, with nothing more to come", async () => {
      const screen = paced({ selected: false }, "broken")
      await ready(screen)
      screen.stream.push(output("broken", 2))
      // It attaches again after the first failure's wait (follow.ts' `redrawMs`).
      await expect.poll(screen.attached, { timeout: 2000 }).toBe(2)
      expect(screen.stream.close).toHaveBeenCalled()
    })
  })

  context("where it can't be seen", () => {
    it("draws what arrives about once a second", async () => {
      const screen = paced({ visible: false })
      await ready(screen)
      screen.stream.push(output("behind", 2))
      await past(domPaceMs * 2)
      expect(screen.drawn()).toEqual([])
      await expect.poll(screen.drawn, { timeout: unseenPaceMs * 2 }).toEqual(["write behind"])
    })
  })
})
