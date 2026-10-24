import {
  createRenderers,
  createView,
  loadWebgl,
  type Drawing,
  type ScreenRenderer,
  type Terminal,
} from "@novadeck/emulator/browser"
import { afterEach, describe as context, describe, expect, it } from "vitest"

// xterm's WebGL addon in a real browser: what it holds of the page's WebGL contexts, which
// Chromium caps. Headless Chromium draws WebGL in software, enough to hold a context.

const opened: (() => void)[] = []
afterEach(() => opened.splice(0).forEach((close) => close()))

// A terminal open in the page, drawing with its DOM renderer.
const terminal = (): { readonly xterm: Terminal; readonly element: HTMLDivElement } => {
  const element = document.createElement("div")
  element.style.cssText = "width: 300px; height: 100px"
  document.body.append(element)
  const view = createView(element, {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
    scrollback: 0,
  })
  const xterm = view.terminal
  xterm.resize(30, 5)
  opened.push(() => {
    view.dispose()
    element.remove()
  })
  return { xterm, element }
}

const webglContexts = (element: HTMLElement): WebGL2RenderingContext[] =>
  [...element.querySelectorAll("canvas")].flatMap((canvas) => canvas.getContext("webgl2") ?? [])

const hasWebgl = Boolean(document.createElement("canvas").getContext("webgl2"))

describe.skipIf(!hasWebgl)("xterm's WebGL renderer", () => {
  context("when a screen goes back to the DOM renderer", () => {
    it("frees its context, so the page's cap doesn't count it until it's collected", () => {
      const { xterm, element } = terminal()
      const drawing = loadWebgl(xterm)
      const [gl] = webglContexts(element)
      expect(gl?.isContextLost()).toBe(false)
      drawing.dispose()
      expect(gl?.isContextLost()).toBe(true)
    })
  })

  context("when loading fails partway, as on a context lost mid-load", () => {
    it("leaves no canvas and no live context behind, and the next load frees its own", () => {
      const { xterm, element } = terminal()
      const prototype = WebGL2RenderingContext.prototype
      const createProgram = prototype.createProgram
      const made: WebGL2RenderingContext[] = []
      prototype.createProgram = function (this: WebGL2RenderingContext) {
        made.push(this)
        prototype.createProgram = createProgram
        // What a lost context gives, though the DOM's types promise a program.
        return null as unknown as WebGLProgram
      }
      try {
        expect(() => loadWebgl(xterm)).toThrow(/falsy/)
      } finally {
        prototype.createProgram = createProgram
      }
      expect(element.querySelectorAll("canvas")).toHaveLength(0)
      expect(made[0]?.isContextLost()).toBe(true)
      const drawing = loadWebgl(xterm)
      const [gl] = webglContexts(element)
      drawing.dispose()
      expect(gl?.isContextLost()).toBe(true)
    })
  })

  context("when two screens draw from one glyph atlas and one clears it", () => {
    // Chromium clears a WebGL canvas once it is shown, and a read after that finds nothing;
    // a context that keeps its buffer can be read at any time. xterm asks for neither.
    const keepBuffers = (): void => {
      const getContext = HTMLCanvasElement.prototype.getContext
      HTMLCanvasElement.prototype.getContext = function (
        this: HTMLCanvasElement,
        type: string,
        attributes?: unknown,
      ) {
        const kept =
          type === "webgl2"
            ? { ...(attributes as object), preserveDrawingBuffer: true }
            : attributes
        return getContext.call(this, type, kept as never)
      } as typeof getContext
      opened.push(() => (HTMLCanvasElement.prototype.getContext = getContext))
    }

    const frame = (): Promise<void> =>
      new Promise((resolve) => requestAnimationFrame(() => resolve()))
    // A few frames: xterm draws in one, and the pool's moment comes before it.
    const frames = (): Promise<void> => frame().then(frame).then(frame)
    const write = (xterm: Terminal, data: string): Promise<void> =>
      new Promise<void>((resolve) => xterm.write(data, resolve)).then(frames)

    // The pixels of a canvas's first row of cells, as drawn.
    const firstRow = (element: HTMLElement, rows: number): string => {
      const canvas = [...element.querySelectorAll("canvas")].find((c) => c.getContext("webgl2"))!
      const copy = document.createElement("canvas")
      copy.width = canvas.width
      copy.height = Math.floor(canvas.height / rows)
      const draw = copy.getContext("2d")!
      draw.drawImage(canvas, 0, 0)
      return draw.getImageData(0, 0, copy.width, copy.height).data.join(",")
    }

    // Many glyphs the atlas has not seen, in colours nothing else uses.
    const flood = (rows: number, cols: number): string => {
      let text = ""
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const n = row * cols + col
          text += `\x1b[38;2;${(n * 7) % 256};${(n * 13 + 50) % 256};${(n * 29 + 90) % 256}m${String.fromCharCode(33 + (n % 90))}`
        }
        text += "\r\n"
      }
      return text + "\x1b[0m"
    }

    it("redraws the other from the cleared atlas, not from coordinates into pages that were wiped", async () => {
      keepBuffers()
      const drawings = new Map<Terminal, Drawing>()
      const screens = new Map<Terminal, ScreenRenderer>()
      const pool = createRenderers<Terminal>({
        load: (xterm) => {
          const drawing = loadWebgl(xterm)
          drawings.set(xterm, drawing)
          return drawing
        },
        supported: () => true,
        cap: 4,
        ligatures: () => false,
        watchLigatures: () => () => {},
      })
      const renderers: typeof pool = {
        ...pool,
        screen: (xterm, switched) => {
          const screen = pool.screen(xterm, switched)
          screens.set(xterm, screen)
          return screen
        },
      }
      const rows = 6
      const open = () => {
        const element = document.createElement("div")
        element.style.cssText = "width: 600px; height: 160px"
        document.body.append(element)
        const view = createView(element, {
          fontSize: 13,
          fontFamily: "monospace",
          theme: {},
          scrollback: 0,
          renderers,
        })
        view.terminal.resize(60, rows)
        view.renderer.take()
        opened.push(() => {
          view.dispose()
          element.remove()
        })
        return { xterm: view.terminal, element }
      }
      const a = open()
      const b = open()
      await frames()
      expect(drawings.get(a.xterm)?.atlas()).toBeDefined()
      expect(drawings.get(a.xterm)?.atlas()).toBe(drawings.get(b.xterm)?.atlas())

      await write(b.xterm, "HEADER row of the other screen, all of it text\r\n")
      const before = firstRow(b.element, rows)

      // The font measure, which clears the screen's atlas, on one of the two.
      screens.get(a.xterm)?.refresh()
      await Promise.resolve()
      await write(a.xterm, flood(rows, 60))
      // The other writes one row that is not the first, which is all it would redraw.
      await write(b.xterm, "\x1b[6;1Hx")

      expect(firstRow(b.element, rows)).toBe(before)
    })
  })

  context("when the program turns the cursor blink on", () => {
    it("clears the blink timer with the renderer", async () => {
      const { xterm } = terminal()
      await new Promise<void>((resolve) => xterm.write("\x1b[?12h", resolve))
      const drawing = loadWebgl(xterm)
      const intervals = new Set<unknown>()
      const { setInterval, clearInterval } = window
      window.setInterval = ((...args: Parameters<typeof setInterval>) => {
        const id = setInterval(...args)
        if (args[1] === 600) intervals.add(id)
        return id
      }) as typeof setInterval
      window.clearInterval = ((id?: number) => {
        intervals.delete(id)
        clearInterval(id)
      }) as typeof clearInterval
      try {
        xterm.focus()
        // The timer starts after a blink's wait.
        await new Promise((resolve) => setTimeout(resolve, 900))
        expect(intervals.size).toBe(1)
        drawing.dispose()
        expect(intervals.size).toBe(0)
      } finally {
        window.setInterval = setInterval
        window.clearInterval = clearInterval
      }
    })
  })
})
