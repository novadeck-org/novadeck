import "@novadeck/emulator/browser.css"
import { createView, loadWebgl, type Terminal } from "@novadeck/emulator/browser"
import { afterEach } from "vitest"
import { cdp } from "vitest/browser"

import { describe, expect, it } from "./test"

// A screen that changes renderer fits its slot again, so the two renderers must measure the same
// cell, or the pty resizes (and an agent's TUI redraws) on every swap. WebGL's cell is whole
// device pixels; xterm's DOM renderer used the font's fractional advance until the emulator
// patch made it the same.
//
// The device pixel ratio is set on the page with CDP's Emulation.setDeviceMetricsOverride (the
// spec's page is an iframe of Vitest's runner's, so a browser context per ratio isn't available);
// xterm follows it through matchMedia like a window moved between displays.

const closers: (() => void)[] = []
const cdpSession = cdp()
afterEach(async () => {
  closers.splice(0).forEach((close) => close())
  await cdpSession.send("Emulation.clearDeviceMetricsOverride")
})

const setRatio = async (ratio: number) => {
  await cdpSession.send("Emulation.setDeviceMetricsOverride", {
    width: 0,
    height: 0,
    deviceScaleFactor: ratio,
    mobile: false,
  })
  await new Promise((done) => requestAnimationFrame(() => done(undefined)))
  expect(window.devicePixelRatio).toBeCloseTo(ratio, 5)
}

// The family's advance at 13 px, from a span: the headless shell hints some fonts (JetBrains Mono)
// to whole pixels, where the renderers would agree without the patch.
const advance = (family: string, size: number): number => {
  const probe = document.createElement("span")
  probe.style.cssText = `position: absolute; visibility: hidden; white-space: pre; font: ${size}px ${family}`
  probe.textContent = "W".repeat(100)
  document.body.append(probe)
  const width = probe.getBoundingClientRect().width / 100
  probe.remove()
  return width
}

const fontSize = 13
const family = "monospace"

const fitted = (width: number, height: number, renderer: "dom" | "webgl") => {
  const element = document.createElement("div")
  element.style.cssText = `position: absolute; left: 0; top: 0; width: ${width}px; height: ${height}px`
  document.body.append(element)
  const view = createView(element, { fontSize, fontFamily: family, theme: {}, scrollback: 1000 })
  const xterm: Terminal = view.terminal
  const drawing = renderer === "webgl" ? loadWebgl(xterm) : undefined
  closers.push(() => {
    drawing?.dispose()
    view.dispose()
    element.remove()
  })
  return view.fit()
}

const hasWebgl = Boolean(document.createElement("canvas").getContext("webgl2"))
const boxes = [
  { width: 800, height: 400 },
  { width: 641, height: 333 },
  { width: 1000, height: 520 },
]

describe.skipIf(!hasWebgl)("a terminal that changes renderer", () => {
  it("is measured on a font whose advance is fractional here", () => {
    expect(advance(family, fontSize) % 1).not.toBe(0)
  })

  // Boxes a row's fraction short of a multiple of the cell height, where a rounded canvas height
  // over the rows (the DOM renderer's old cell height) fits one row more than WebGL's.
  describe.each([
    { ratio: 1.1, width: 800, height: 340 },
    { ratio: 1.25, width: 796, height: 228 },
    { ratio: 1.25, width: 800, height: 304 },
    { ratio: 1.5, width: 810, height: 230 },
  ])("at a device pixel ratio of $ratio", ({ ratio, width, height }) => {
    it(`fits ${width} x ${height} to the same rows`, async () => {
      await setRatio(ratio)
      const dom = fitted(width, height, "dom")
      expect(dom).toBeDefined()
      expect(fitted(width, height, "webgl")).toEqual(dom)
    })
  })

  describe.each([1, 1.25, 1.5, 2])("at a device pixel ratio of %s", (ratio) => {
    it.each(boxes)("fits $width x $height to the same columns and rows", async (box) => {
      await setRatio(ratio)
      const dom = fitted(box.width, box.height, "dom")
      const webgl = fitted(box.width, box.height, "webgl")
      expect(dom).toBeDefined()
      expect(webgl).toEqual(dom)
    })
  })
})
