import {
  createRenderers,
  createView,
  type Drawing,
  type Terminal,
} from "@novadeck/emulator/browser"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  closeViews,
  emulatorPrototype,
  loading,
  openedTerminals,
  optionsOf,
  running,
  slot,
  starting,
  themed,
  viewsOf,
} from "./fakes.test-support.js"
import type { ViewEvents } from "./follow.js"

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

// A screen closes once its session has stayed off screen for its retention; it closes here
// instead, while the file's DOM is still there to take its listeners off.
afterEach(closeViews)

describe("a terminal's screen resized out of view", () => {
  // Cells of 8 by 17, and a view of the screen that reports where the test says.
  const measured = () => {
    const reports: ((entries: { isIntersecting: boolean }[]) => void)[] = []
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        constructor(report: (entries: { isIntersecting: boolean }[]) => void) {
          reports.push(report)
        }
        observe(): void {}
        disconnect(): void {}
      },
    )
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(8 * 32)
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(17)
    return (isIntersecting: boolean) => reports.forEach((report) => report([{ isIntersecting }]))
  }
  afterEach(() => vi.unstubAllGlobals())

  it("keeps following its shell's output", async () => {
    const view = measured()
    const screens = viewsOf(
      optionsOf({
        // With scrollback, for the viewport to follow.
        emulator: (host, open) => createView(host, { ...open, scrollback: 1000 }),
        lifecycle: () => starting(),
      }),
    )
    const opened = openedTerminals()
    screens.acquire("out-of-view", { label: "Input for T", phase: "running", webgl: false })
    const xterm = opened[0]!
    const write = (lines: number) =>
      new Promise<void>((resolve) => xterm.write("output\r\n".repeat(lines), resolve))
    view(true)
    await write(3)
    view(false)
    // The output is parsed before the renderer, which waits for an idle moment while the
    // screen is out of view, takes the new size.
    const drawn = write(40)
    xterm.resize(64, 19)
    await drawn
    expect(xterm.buffer.active.baseY).toBeGreaterThan(0)
    expect(xterm.buffer.active.viewportY).toBe(xterm.buffer.active.baseY)
  })
})

describe("a screen's renderer", () => {
  // Screens drawing through a pool of fake drawings, which record what loads and goes. Every
  // fit gives a size, so each refit tells the owner.
  const wired = () => {
    const loaded: Terminal[] = []
    const drawings: { disposed: boolean }[] = []
    const watching = { count: 0 }
    const renderers = createRenderers<Terminal>({
      load: (xterm) => {
        loaded.push(xterm)
        const drawing = { disposed: false }
        drawings.push(drawing)
        return {
          onContextLoss: () => ({ dispose: () => {} }),
          clearTextureAtlas: () => {},
          dispose: () => void (drawing.disposed = true),
        } satisfies Drawing
      },
      supported: () => true,
      cap: 12,
      ligatures: () => false,
      watchLigatures: () => {
        watching.count += 1
        return () => void (watching.count -= 1)
      },
    })
    // The screens' hosts have a size, as laid out; nothing else in the page does.
    for (const [name, value] of [
      ["clientWidth", 800],
      ["clientHeight", 600],
    ] as const) {
      const original = Object.getOwnPropertyDescriptor(Element.prototype, name)!.get!
      vi.spyOn(Element.prototype, name, "get").mockImplementation(function (this: Element) {
        return this.classList.contains("screen") ? value : original.call(this)
      })
    }
    const resized = vi.fn<NonNullable<ViewEvents<string>["resized"]>>()
    const closed = new Set<string>()
    const page = themed()
    const screens = viewsOf(
      optionsOf({
        emulator: (host, open) => createView(host, { ...open, scrollback: 0, renderers }),
        theme: page.theme,
        markup: { hostClass: "screen" },
        lifecycle: (key) => starting({ closed: closed.has(key) }),
        on: { resized },
      }),
    )
    // The fit addon is the view's own, so it is reached as the terminal loads it.
    const prototype = emulatorPrototype()
    const loadAddon = prototype.loadAddon
    vi.spyOn(prototype, "loadAddon").mockImplementation(function (
      this: Terminal,
      addon: Parameters<Terminal["loadAddon"]>[0],
    ) {
      if ("proposeDimensions" in addon && typeof addon.proposeDimensions === "function")
        vi.spyOn(
          addon as { proposeDimensions: () => unknown },
          "proposeDimensions",
        ).mockReturnValue({
          cols: 100,
          rows: 30,
        })
      return loadAddon.call(this, addon)
    })
    // Holds the terminals `ids` in elements of their own, as a view places them, asking for
    // WebGL or not.
    const mount = (webgl: boolean, ...ids: string[]) => {
      const holds = ids.map((id) => {
        const hold = screens.acquire(id, { ...running, webgl })
        hold.place(slot())
        return hold
      })
      return {
        update: (change: { webgl: boolean }) => holds.forEach((hold) => hold.update(change)),
        unmount: () => holds.forEach((hold) => hold.release({ unmount: true })),
      }
    }
    return { loaded, drawings, watching, resized, closed, mount, page }
  }

  it("loads WebGL for a screen that asks for it and nothing for one that doesn't", () => {
    const { loaded, drawings, mount } = wired()
    const page = mount(false, "01")
    expect(loaded).toHaveLength(0)
    page.update({ webgl: true })
    expect(loaded).toHaveLength(1)
    page.update({ webgl: false })
    expect(drawings.map((drawing) => drawing.disposed)).toEqual([true])
  })

  it("fits the screen again each time it changes renderer", () => {
    const { resized, mount } = wired()
    const page = mount(true, "01")
    expect(resized).toHaveBeenCalledWith("01", { cols: 100, rows: 30 })
    resized.mockClear()
    page.update({ webgl: false })
    expect(resized).toHaveBeenCalledTimes(1)
    page.update({ webgl: true })
    expect(resized).toHaveBeenCalledTimes(2)
  })

  it("fits the screen again once a font it waited for arrives", async () => {
    const { resized, mount, page } = wired()
    page.apply("Bundled Mono")
    const font = loading()
    // A resize's settling refit waits on a timer, and a placed host's second fit on the next
    // frame; with both held, only the font's refit counts.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"],
    })
    try {
      mount(true, "01")
      resized.mockClear()

      font.arrive()
      await vi.advanceTimersByTimeAsync(0)

      expect(resized).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
      font.restore()
    }
  })

  it("gives the context back when the screen parks, not when a hold returns in time", () => {
    const { drawings, mount } = wired()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const page = mount(true, "01")
      page.unmount()
      vi.advanceTimersByTime(4_000)
      expect(drawings[0]!.disposed).toBe(false)
      const back = mount(true, "01")
      vi.advanceTimersByTime(10_000)
      expect(drawings).toHaveLength(1)
      expect(drawings[0]!.disposed).toBe(false)
      back.unmount()
      vi.advanceTimersByTime(4_999)
      expect(drawings[0]!.disposed).toBe(false)
      vi.advanceTimersByTime(1)
      expect(drawings[0]!.disposed).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it("watches the ligatures setting until the last screen goes", () => {
    const { watching, closed, mount } = wired()
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
    try {
      const page = mount(true, "01", "02")
      expect(watching.count).toBe(1)
      page.unmount()
      closed.add("01")
      vi.advanceTimersByTime(1_000)
      expect(watching.count).toBe(1)
      closed.add("02")
      vi.advanceTimersByTime(1_000)
      expect(watching.count).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
