import {
  createRenderers,
  createView,
  type Drawing,
  type Terminal,
} from "@novadeck/emulator/browser"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { AttachStream } from "../contract.js"
import {
  closeViews,
  emulatorPrototype,
  loading,
  openedTerminals,
  optionsOf,
  output,
  running,
  shell,
  slot,
  snapshot,
  starting,
  streamOf,
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
    const renderers = createRenderers<Terminal>({
      load: (xterm) => {
        loaded.push(xterm)
        const drawing = { disposed: false }
        drawings.push(drawing)
        return {
          onContextLoss: () => ({ dispose: () => {} }),
          clearTextureAtlas: () => {},
          atlas: () => undefined,
          dispose: () => void (drawing.disposed = true),
        } satisfies Drawing
      },
      supported: () => true,
      cap: 12,
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
    const stream = streamOf()
    const resized = vi.fn<NonNullable<ViewEvents<string>["resized"]>>()
    const closed = new Set<string>()
    const page = themed()
    const screens = viewsOf(
      optionsOf({
        emulator: (host, open) => createView(host, { ...open, scrollback: 0, renderers }),
        theme: page.theme,
        markup: { hostClass: "screen" },
        lifecycle: (key) => shell({ closed: closed.has(key) }),
        attach: () => Promise.resolve(stream.attached),
        on: { resized },
      }),
    )
    // The size every fit gives, which a test may change.
    const fit = { cols: 100, rows: 30 }
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
        ).mockImplementation(() => ({ ...fit }))
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
    return { loaded, drawings, resized, closed, mount, page, renderers, fit, stream }
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

  it("counts a renderer change's resize of the pty only when the fit is another size", async () => {
    const { renderers, mount, fit, stream } = wired()
    const page = mount(true, "01")
    // The shell attaches, and its pty takes the size that fits.
    await vi.waitFor(() => expect(stream.resized).toEqual(["100x30"]))
    expect(renderers.stats().resizes).toBe(0)
    fit.cols = 90
    page.update({ webgl: false })
    expect(stream.resized).toEqual(["100x30", "90x30"])
    expect(renderers.stats()).toMatchObject({ swaps: 2, resizes: 1 })
    // The next change fits the same size again.
    page.update({ webgl: true })
    expect(stream.resized).toHaveLength(2)
    expect(renderers.stats()).toMatchObject({ swaps: 3, resizes: 1 })
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
})

describe("a screen its emulator fails to draw", () => {
  afterEach(() => vi.unstubAllGlobals())

  // A buffer whose rows went missing makes the emulator throw while parsing; a sequence of the
  // test's own throws in its place. Before, the screen stayed on "Loading output…" for good.
  it("draws the host's screen afresh and takes input again", async () => {
    const thrown: unknown[] = []
    const queue = globalThis.queueMicrotask
    vi.stubGlobal("queueMicrotask", (task: () => void) =>
      queue(() => {
        try {
          task()
        } catch (error) {
          thrown.push(error)
        }
      }),
    )
    const first = streamOf([snapshot("$ before\x1b[z")])
    const second = streamOf([snapshot("$ fresh")])
    const attach = vi
      .fn<() => Promise<AttachStream>>()
      .mockResolvedValueOnce(first.attached)
      .mockResolvedValue(second.attached)
    const screens = viewsOf(optionsOf({ attach }))
    const opened = openedTerminals()
    const hold = screens.acquire("garbled", running)
    const xterm = opened[0]!
    const broken = new Error("no such row")
    xterm.parser.registerCsiHandler({ final: "z" }, () => {
      throw broken
    })
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
    await vi.waitFor(() =>
      expect(hold.state.getSnapshot()).toMatchObject({ live: true, lock: null }),
    )
    expect(first.close).toHaveBeenCalled()
    expect(thrown).toEqual([broken])
    expect(xterm.buffer.active.getLine(0)?.translateToString(true)).toBe("$ fresh")
    hold.release()
  })

  it("draws a screen afresh after a stream cut inside a sequence", async () => {
    const first = streamOf([snapshot("$ before"), output("\x1b[", 2)])
    const second = streamOf([snapshot("$ after")])
    const attach = vi
      .fn<() => Promise<AttachStream>>()
      .mockResolvedValueOnce(first.attached)
      .mockResolvedValue(second.attached)
    const screens = viewsOf(optionsOf({ attach, park: { afterMs: 0, keep: 16 } }))
    const opened = openedTerminals()
    const hold = screens.acquire("cut", running)
    const xterm = opened[0]!
    await vi.waitFor(() => expect(hold.state.getSnapshot().live).toBe(true))
    await new Promise<void>((resolve) => xterm.write("", resolve))
    // Parked out of sight, then shown again.
    hold.release()
    await vi.waitFor(() => expect(first.close).toHaveBeenCalled())
    const again = screens.acquire("cut", running)
    await vi.waitFor(() => expect(attach).toHaveBeenCalledTimes(2))
    await vi.waitFor(() => expect(again.state.getSnapshot().live).toBe(true))
    await new Promise<void>((resolve) => xterm.write("", resolve))
    expect(xterm.buffer.active.getLine(0)?.translateToString(true)).toBe("$ after")
    again.release()
  })
})
