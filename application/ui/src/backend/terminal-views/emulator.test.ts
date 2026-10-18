import { createRenderers, type Terminal } from "@novadeck/emulator/browser"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../../test"
import { openEmulator } from "./emulator"

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

// A pool that never hands out WebGL, so every screen draws with the DOM.
const noWebgl = createRenderers<Terminal>({
  load: () => {
    throw new Error("No WebGL here")
  },
  supported: () => false,
  cap: 0,
  ligatures: () => false,
  watchLigatures: () => () => {},
})

const open = (screenReader: boolean) => {
  const element = document.body.appendChild(document.createElement("div"))
  const view = openEmulator({ renderers: noWebgl, screenReader })(element, {
    fontSize: 13,
    fontFamily: "monospace",
    theme: {},
  })
  return { element, view, input: view.terminal.textarea! }
}

// Where a screen reader hears a terminal: its live region, which only its tree carries.
const liveRegion = (element: Element): Element | null => element.querySelector("[aria-live]")

describe("a screen's emulator", () => {
  afterEach(() => document.body.replaceChildren())

  it("speaks for the terminal in focus alone, and stops once it leaves", () => {
    const first = open(true)
    const second = open(true)
    expect(liveRegion(first.element)).toBeNull()
    first.input.focus()
    expect(liveRegion(first.element)).not.toBeNull()
    expect(liveRegion(second.element)).toBeNull()
    second.input.focus()
    expect(liveRegion(first.element)).toBeNull()
    expect(liveRegion(second.element)).not.toBeNull()
  })

  it("keeps no screen reader's tree where not asked, focused or not", () => {
    const { element, input } = open(false)
    input.focus()
    expect(liveRegion(element)).toBeNull()
  })

  it("stops listening for focus once disposed", () => {
    const { view, input } = open(true)
    view.dispose()
    expect(() => input.dispatchEvent(new FocusEvent("focus"))).not.toThrow()
  })
})
