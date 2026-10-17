import { Terminal } from "@novadeck/emulator/browser"
import { afterEach, describe as context, describe, expect, it } from "vitest"

import { loadWebgl } from "./renderer"

// xterm's WebGL addon in a real browser: what it holds of the page's WebGL contexts, which
// Chromium caps. Headless Chromium draws WebGL in software, enough to hold a context.

const opened: (() => void)[] = []
afterEach(() => opened.splice(0).forEach((close) => close()))

// A terminal open in the page, drawing with its DOM renderer.
const terminal = (): { readonly xterm: Terminal; readonly element: HTMLDivElement } => {
  const element = document.createElement("div")
  element.style.cssText = "width: 300px; height: 100px"
  document.body.append(element)
  const xterm = new Terminal({ cols: 30, rows: 5 })
  xterm.open(element)
  opened.push(() => {
    xterm.dispose()
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
})
