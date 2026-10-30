// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm"
import { afterEach, describe, expect, it, vi } from "vitest"

import { createRendererPool, type Drawing } from "./renderer.js"
import { createView, type View, type ViewOptions } from "./view.js"
import { cells } from "./width.js"

// The web-links addon is recorded, to call the handlers the view gave it.
const addons = vi.hoisted(
  () =>
    [] as {
      activate: (event: MouseEvent, uri: string) => void
      hint?: { hover: (event: MouseEvent, uri: string) => void; leave: () => void }
    }[],
)
vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: class {
    constructor(
      activate: (typeof addons)[number]["activate"],
      hint?: (typeof addons)[number]["hint"],
    ) {
      addons.push({ activate, ...(hint && { hint }) })
    }
    activate(): void {}
    dispose(): void {}
  },
}))

// jsdom has no canvas or media queries; xterm opens without them.
vi.hoisted(() => {
  HTMLCanvasElement.prototype.getContext = () => null
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

const opened: (() => void)[] = []
afterEach(() => {
  vi.restoreAllMocks()
  addons.length = 0
  opened.splice(0).forEach((close) => close())
  Reflect.deleteProperty(document, "fonts")
})

const open = (options: Partial<ViewOptions> = {}): { view: View; element: HTMLDivElement } => {
  const element = document.createElement("div")
  document.body.append(element)
  const view = createView(element, {
    fontSize: 13,
    fontFamily: "Test Mono",
    theme: { background: "#101010" },
    scrollback: 100,
    ...options,
  })
  opened.push(() => {
    view.dispose()
    element.remove()
  })
  return { view, element }
}

const click = (): MouseEvent => new MouseEvent("click")
const range = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } }

// A document whose fonts load when the test says so.
const fonts = () => {
  const loads: { family: string; settle: (loaded: boolean) => void }[] = []
  const loaded = new Set<string>()
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      check: (font: string) => loaded.has(font),
      load: (font: string) =>
        new Promise<void>((resolve, reject) =>
          loads.push({ family: font, settle: (ok) => (ok ? resolve() : reject(new Error("no"))) }),
        ),
    },
  })
  return { loads, loaded }
}

describe("a view", () => {
  it("opens its terminal in the element, with the options it was given", () => {
    const { view, element } = open()
    expect(element.querySelector(".xterm")).toBe(view.terminal.element)
    expect(view.terminal.options).toMatchObject({
      fontSize: 13,
      fontFamily: "Test Mono",
      scrollback: 100,
      allowTransparency: false,
      allowProposedApi: true,
      theme: { background: "#101010" },
    })
  })

  it("passes a minimum contrast ratio on, and leaves xterm's own without one", () => {
    expect(open().view.terminal.options.minimumContrastRatio).toBe(1)
    expect(open({ minimumContrastRatio: 4.5 }).view.terminal.options.minimumContrastRatio).toBe(4.5)
  })

  it("counts widths as every other emulator here does", async () => {
    const { view } = open()
    const text = "\u{1f468}‍\u{1f469}‍\u{1f467}\u{1f44d}\u{1f3fd}"
    await new Promise<void>((resolve) => view.terminal.write(text, resolve))
    expect(view.terminal.buffer.active.cursorX).toBe(cells(text))
  })

  it("takes a new theme", () => {
    const { view } = open()
    view.setTheme({ background: "#ffffff" })
    expect(view.terminal.options.theme).toMatchObject({ background: "#ffffff" })
  })

  it("closes its terminal and leaves the element", () => {
    const { view, element } = open()
    const dispose = vi.spyOn(view.terminal, "dispose")
    view.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(element.isConnected).toBe(true)
  })
})

describe("a view's fit", () => {
  const sized = (element: HTMLElement): void => {
    Object.defineProperty(element, "clientWidth", { configurable: true, value: 800 })
    Object.defineProperty(element, "clientHeight", { configurable: true, value: 600 })
  }
  // The fit addon is the view's own, so it is reached as the terminal loads it.
  const proposing = (proposal: unknown): void => {
    const terminal = Object.getPrototypeOf(open().view.terminal) as {
      loadAddon: (addon: object) => void
    }
    const loadAddon = terminal.loadAddon
    vi.spyOn(terminal, "loadAddon").mockImplementation(function (this: object, addon: object) {
      if ("proposeDimensions" in addon)
        vi.spyOn(
          addon as { proposeDimensions: () => unknown },
          "proposeDimensions",
        ).mockReturnValue(proposal)
      return loadAddon.call(this, addon)
    })
  }

  it("is undefined while the element has no size", () => {
    expect(open().view.fit()).toBeUndefined()
  })

  it("is the size the fit addon proposes for an element that has one", () => {
    proposing({ cols: 100.7, rows: 30 })
    const { view, element } = open()
    sized(element)
    expect(view.fit()).toEqual({ cols: 100.7, rows: 30 })
  })

  it("is undefined while the proposal is not a finite size", () => {
    proposing({ cols: Number.NaN, rows: 30 })
    const { view, element } = open()
    sized(element)
    expect(view.fit()).toBeUndefined()
  })
})

describe("a view's font", () => {
  it("measures a loaded font at once, once, and resolves whether it did", async () => {
    const { loaded } = fonts()
    loaded.add("13px Other Mono")
    const { view } = open()
    const changes: unknown[] = []
    const options = view.terminal.options
    const family = vi.spyOn(options, "fontFamily", "set")
    family.mockImplementation((value) => void changes.push(value))
    expect(await view.setFont("Other Mono")).toBe(true)
    expect(changes).toEqual(["Other Mono"])
  })

  it("waits for a font on its way, and measures through monospace when the family stays", async () => {
    const { loads } = fonts()
    const { view } = open()
    const changes: string[] = []
    const options = view.terminal.options
    let current = options.fontFamily
    Object.defineProperty(options, "fontFamily", {
      configurable: true,
      get: () => current,
      set: (value: string) => void changes.push((current = value)),
    })
    const done = view.setFont("Test Mono")
    expect(changes).toEqual([])
    loads[0]!.settle(true)
    expect(await done).toBe(true)
    expect(changes).toEqual(["monospace", "Test Mono"])
  })

  it("takes a font that fails to load all the same", async () => {
    const { loads } = fonts()
    const { view } = open()
    const done = view.setFont("Missing Mono")
    loads[0]!.settle(false)
    expect(await done).toBe(true)
    expect(view.terminal.options.fontFamily).toBe("Missing Mono")
  })

  it("resolves false when nothing changed", async () => {
    const { loaded } = fonts()
    loaded.add("13px Test Mono")
    expect(await open().view.setFont("Test Mono")).toBe(false)
  })

  it("resolves false for a font already awaited, and for one a later call took over", async () => {
    const { loads } = fonts()
    const { view } = open()
    const first = view.setFont("First Mono")
    expect(await view.setFont("First Mono")).toBe(false)
    const second = view.setFont("Second Mono")
    loads[0]!.settle(true)
    expect(await first).toBe(false)
    expect(view.terminal.options.fontFamily).toBe("Test Mono")
    loads[1]!.settle(true)
    expect(await second).toBe(true)
    expect(view.terminal.options.fontFamily).toBe("Second Mono")
  })

  it("leaves a view that closed before the font arrived", async () => {
    const { loads } = fonts()
    const { view } = open()
    const done = view.setFont("Late Mono")
    view.dispose()
    loads[0]!.settle(true)
    expect(await done).toBe(false)
  })

  it("measures nothing once the view has closed, even for a loaded font", async () => {
    const { loaded } = fonts()
    loaded.add("13px Other Mono")
    const { view } = open()
    view.dispose()
    expect(await view.setFont("Other Mono")).toBe(false)
  })

  it("clears the WebGL atlas when it measures", async () => {
    const { loaded } = fonts()
    loaded.add("13px Other Mono")
    const cleared = vi.fn<() => void>()
    const pool = createRendererPool<Terminal>({
      load: () => ({
        onContextLoss: () => ({ dispose: () => {} }),
        clearTextureAtlas: cleared,
        atlas: () => undefined,
        dispose: () => {},
      }),
      supported: () => true,
      cap: 1,
    })
    const { view } = open({ pool })
    view.renderer.take()
    await view.setFont("Other Mono")
    expect(cleared).toHaveBeenCalledTimes(1)
  })
})

describe("a view's links", () => {
  const handlerOf = (view: View) => view.terminal.options.linkHandler!

  it("opens the link a program printed, with the click that activated it", () => {
    const opens = vi.fn<(uri: string, event: MouseEvent) => void>()
    const { view } = open({ links: { open: opens } })
    const event = click()
    handlerOf(view).activate(event, "https://example.com/", range)
    expect(opens).toHaveBeenCalledWith("https://example.com/", event)
  })

  it("opens an address in the text on activation, the same way", () => {
    const opens = vi.fn<(uri: string, event: MouseEvent) => void>()
    open({ links: { open: opens } })
    const event = click()
    addons[0]!.activate(event, "https://example.com/a")
    expect(opens).toHaveBeenCalledWith("https://example.com/a", event)
  })

  it("titles the element while a link is hovered, and not after", () => {
    const { view } = open({ links: { open: () => {}, title: (uri) => `to ${uri}` } })
    handlerOf(view).hover!(click(), "https://example.com/", range)
    expect(view.terminal.element?.getAttribute("title")).toBe("to https://example.com/")
    handlerOf(view).leave!(click(), "https://example.com/", range)
    expect(view.terminal.element?.hasAttribute("title")).toBe(false)
    // An address in the text shows it too.
    addons[0]!.hint!.hover(click(), "https://example.com/a")
    expect(view.terminal.element?.getAttribute("title")).toBe("to https://example.com/a")
    addons[0]!.hint!.leave()
    expect(view.terminal.element?.hasAttribute("title")).toBe(false)
  })

  it("shows no title without a title function", () => {
    const { view } = open({ links: { open: () => {} } })
    expect(handlerOf(view).hover).toBeUndefined()
  })

  it("handles no links without the option", () => {
    expect(open().view.terminal.options.linkHandler).toBeFalsy()
  })
})

describe("a view's renderer", () => {
  const drawingPool = () => {
    const drawings: Drawing[] = []
    return {
      drawings,
      pool: createRendererPool<Terminal>({
        load: () => {
          const drawing: Drawing = {
            onContextLoss: () => ({ dispose: () => {} }),
            clearTextureAtlas: () => {},
            atlas: () => undefined,
            dispose: () => {},
          }
          drawings.push(drawing)
          return drawing
        },
        supported: () => true,
        cap: 2,
      }),
    }
  }

  it("tells of each change of renderer, but not as the view closes", () => {
    const { pool } = drawingPool()
    const changed = vi.fn<() => void>()
    const { view } = open({ pool })
    view.onRendererChange(changed)
    view.renderer.take()
    expect(changed).toHaveBeenCalledTimes(1)
    view.renderer.release()
    expect(changed).toHaveBeenCalledTimes(2)
    view.renderer.take()
    view.dispose()
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it("leaves a view without a pool on the DOM renderer", () => {
    const { view } = open()
    expect(() => {
      view.renderer.take()
      view.renderer.idle()
      view.renderer.release()
    }).not.toThrow()
  })

  it("stops telling a listener that has stopped listening", () => {
    const { pool } = drawingPool()
    const changed = vi.fn<() => void>()
    const { view } = open({ pool })
    view.onRendererChange(changed).dispose()
    view.renderer.take()
    expect(changed).not.toHaveBeenCalled()
  })
})

describe("a view's ligatures", () => {
  const pool = () =>
    createRendererPool<Terminal>({
      load: () => ({
        onContextLoss: () => ({ dispose: () => {} }),
        clearTextureAtlas: () => {},
        atlas: () => undefined,
        dispose: () => {},
      }),
      supported: () => true,
      cap: 1,
    })

  // The joiner xterm holds for the view, as the character joiner service lists them.
  const joiners = (view: View): { handler: (text: string) => [number, number][] }[] =>
    /* eslint-disable no-underscore-dangle -- Its only way out is its internals. */
    (
      view.terminal as unknown as {
        _core: { _characterJoinerService: { _characterJoiners: never[] } }
      }
    )._core._characterJoinerService._characterJoiners
  /* eslint-enable no-underscore-dangle */

  it("hands WebGL the font's runs while ligatures are on and WebGL draws the view", () => {
    const { view } = open({ pool: pool(), fontFamily: "'JetBrains Mono Variable', monospace" })
    view.renderer.take()
    view.setLigatures(true)
    expect(joiners(view)).toHaveLength(1)
    expect(joiners(view)[0]!.handler("a => b !== c")).toEqual([
      [2, 4],
      [7, 10],
    ])
  })

  it("keeps the joiner off the DOM renderer, which draws ligatures from its text", () => {
    const { view } = open({ pool: pool(), fontFamily: "'JetBrains Mono Variable', monospace" })
    view.setLigatures(true)
    expect(joiners(view)).toHaveLength(0)
    expect(open().view.setLigatures(true)).toBeUndefined()
  })

  it("follows the view between renderers and the setting going off", () => {
    const { view } = open({ pool: pool(), fontFamily: "'JetBrains Mono Variable', monospace" })
    view.setLigatures(true)
    view.renderer.take()
    expect(joiners(view)).toHaveLength(1)
    view.renderer.release()
    expect(joiners(view)).toHaveLength(0)
    view.renderer.take()
    expect(joiners(view)).toHaveLength(1)
    view.setLigatures(false)
    expect(joiners(view)).toHaveLength(0)
  })

  it("draws the screen again when the joiner comes or goes", () => {
    const { view } = open({ pool: pool(), fontFamily: "'JetBrains Mono Variable', monospace" })
    view.renderer.take()
    const refresh = vi.spyOn(view.terminal, "refresh")
    view.setLigatures(true)
    view.setLigatures(true)
    view.setLigatures(false)
    expect(refresh).toHaveBeenCalledTimes(2)
  })

  it("keeps the joiner off another face, whose glyphs the table's runs would squeeze for nothing", async () => {
    const { view } = open({ pool: pool(), fontFamily: "'Share Tech Mono', monospace" })
    view.renderer.take()
    view.setLigatures(true)
    expect(joiners(view)).toHaveLength(0)
    // A font that turns out to be JetBrains Mono's brings it.
    await view.setFont("'JetBrains Mono Variable', monospace")
    expect(joiners(view)).toHaveLength(1)
    await view.setFont("'Share Tech Mono', monospace")
    expect(joiners(view)).toHaveLength(0)
  })

  it("cuts a long line into runs the glyph atlas holds", () => {
    const { view } = open({ pool: pool(), fontFamily: "'JetBrains Mono Variable', monospace" })
    view.renderer.take()
    view.setLigatures(true)
    const runs = joiners(view)[0]!.handler("=".repeat(200))
    expect(runs.length).toBeGreaterThan(5)
    for (const [from, to] of runs) expect(to - from).toBeLessThanOrEqual(32)
  })
})
