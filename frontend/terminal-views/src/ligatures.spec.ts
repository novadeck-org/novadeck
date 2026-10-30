import "@novadeck/emulator/browser.css"
import fontUrl from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url"
import { createRenderers, createView, loadWebgl, type View } from "@novadeck/emulator/browser"
import { afterAll, afterEach, beforeAll } from "vitest"
import { page } from "vitest/browser"

import { describe, expect, it } from "./test"

// Ligatures drawn by WebGL, in a real browser: one glyph per run of cells the font joins, held
// to the grid, and left alone where the cells differ. A screen is read as pixels (a screenshot
// of its element) and compared with the same screen drawn without ligatures.
//
// 13 px JetBrains Mono advances 7.8 px, and a cell is `floor(7.8 * ratio) / ratio`: 7 px at a
// ratio of 1, where a run drawn at the font's own advance spills past its cells. The spec runs at
// the runner's ratio of 1: a page in the runner's iframe keeps xterm's WebGL canvas at CSS size
// whatever ratio is set on it, so other ratios are measured outside it (the emulator's README).

const family = "'JetBrains Mono Variable', monospace"
const fontSize = 13

// A WebGL canvas is read back as it was drawn only if its buffer is kept, and a screenshot of
// the page is in CSS pixels, so a ratio's device pixels are read from the canvas itself.
const getContext = HTMLCanvasElement.prototype.getContext
beforeAll(async () => {
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attributes?: unknown,
  ) {
    return getContext.call(
      this,
      type,
      type === "webgl2" ? { ...(attributes as object), preserveDrawingBuffer: true } : attributes,
    )
  } as typeof getContext
  const face = new FontFace("JetBrains Mono Variable", `url(${fontUrl})`, { weight: "100 800" })
  document.fonts.add(await face.load())
})

const closers: (() => void)[] = []
afterEach(() => {
  closers.splice(0).forEach((close) => close())
})

afterAll(() => {
  HTMLCanvasElement.prototype.getContext = getContext
})

const frames = async (count: number) => {
  for (let i = 0; i < count; i++)
    // eslint-disable-next-line no-await-in-loop -- A frame after a frame.
    await new Promise((done) => requestAnimationFrame(done))
}

// What is written: each row's text and where its ligature runs are, in cells.
const rows = [
  { text: "  ===", cells: [2, 5] },
  { text: "  <!--", cells: [2, 6] },
  { text: "  ->", cells: [2, 4] },
  { text: "  !==", cells: [2, 5] },
  { text: "  ==========", cells: [2, 12] },
  // Red `=` then plain `>`: one ligature if they were joined, which different attributes forbid.
  { text: "  \x1b[31m=\x1b[0m>", cells: undefined },
  { text: "  abc def", cells: undefined },
] as const

const open = async (
  renderer: "webgl" | "dom",
  on: boolean,
  layout: { readonly lines: readonly string[]; readonly cols: number } = {
    lines: rows.map((row) => row.text),
    cols: 30,
  },
) => {
  const element = document.createElement("div")
  element.style.cssText = `position: absolute; left: 0; top: 0; width: ${layout.cols * 8}px; height: ${layout.lines.length * 20}px`
  // The DOM renderer takes ligatures from the page's CSS (theme/base.css names calt).
  if (renderer === "dom") element.style.fontFeatureSettings = '"calt"'
  document.body.append(element)
  const pool = createRenderers({ load: loadWebgl, supported: () => true, cap: 4 })
  const view: View = createView(element, {
    fontSize,
    fontFamily: family,
    theme: { background: "#000000", foreground: "#ffffff" },
    scrollback: 0,
    ...(renderer === "webgl" && { renderers: pool }),
  })
  closers.push(() => {
    view.dispose()
    element.remove()
  })
  view.terminal.resize(layout.cols, layout.lines.length)
  view.terminal.write("\x1b[?25l")
  for (const [i, line] of layout.lines.entries())
    // eslint-disable-next-line no-await-in-loop -- Each write follows the last.
    await new Promise<void>((done) =>
      view.terminal.write(`${i ? "\r\n" : ""}${line}`, () => done()),
    )
  if (renderer === "webgl") view.renderer.take()
  view.setLigatures(on)
  await frames(3)
  return { view, element }
}

type Pixels = { readonly width: number; readonly height: number; readonly data: Uint8ClampedArray }

const pixelsOf = (source: CanvasImageSource, width: number, height: number): Pixels => {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext("2d")!
  context.drawImage(source, 0, 0)
  return { width, height, data: context.getImageData(0, 0, width, height).data }
}

// The screen's device pixels: the WebGL canvas as drawn, or for a DOM screen a screenshot of
// its element, which is in CSS pixels (so only as sharp as a ratio of 1).
const read = async (element: HTMLElement): Promise<Pixels> => {
  await frames(3)
  const webgl = [...element.querySelectorAll("canvas")].find((canvas) =>
    canvas.getContext("webgl2"),
  )
  if (webgl) return pixelsOf(webgl, webgl.width, webgl.height)
  // Not saved, a screenshot is its base64 string.
  const base64 = await page.screenshot({ element, save: false })
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const image = await createImageBitmap(new Blob([bytes], { type: "image/png" }))
  return pixelsOf(image, image.width, image.height)
}

// Row `row`'s pixels: where its ink starts and ends (device pixels) and a copy to compare.
const rowInk = (pixels: Pixels, row: number, cellHeight: number) => {
  let left = Infinity
  let right = -1
  const band: number[] = []
  for (let y = row * cellHeight; y < (row + 1) * cellHeight; y++)
    for (let x = 0; x < pixels.width; x++) {
      const value = pixels.data[(y * pixels.width + x) * 4 + 1]! // green: red text keeps some
      band.push(value)
      if (value > 60) {
        left = Math.min(left, x)
        right = Math.max(right, x)
      }
    }
  return { left, right: right + 1, band }
}

/* eslint-disable no-underscore-dangle -- Its only way out is its internals. */
const cellOf = (view: View) =>
  (
    view.terminal as unknown as {
      _core: {
        _renderService: { dimensions: { device: { cell: { width: number; height: number } } } }
      }
    }
  )._core._renderService.dimensions.device.cell
/* eslint-enable no-underscore-dangle */

const ratio = window.devicePixelRatio

describe("ligatures drawn by WebGL", () => {
  it("joins runs of cells, within the grid, and leaves the rest as they were", async () => {
    const off = await open("webgl", false)
    const cell = cellOf(off.view)
    // The advance really is fractional here, or the test proves nothing about fitting.
    expect(cell.width).toBe(Math.floor(7.8 * ratio))
    const before = await read(off.element)
    off.view.setLigatures(true)
    const after = await read(off.element)

    const inkOf = (i: number) => ({
      was: rowInk(before, i, cell.height),
      now: rowInk(after, i, cell.height),
    })
    // Mixed attributes and plain words: not joined, so not a pixel different.
    rows.forEach((row, i) => {
      if (row.cells) return
      expect(inkOf(i).now.band, `row ${i}`).toEqual(inkOf(i).was.band)
    })
    for (const [i, row] of rows.entries()) {
      const [from, to] = row.cells ?? [0, 0]
      const { was, now } = inkOf(i)
      const joined = row.cells !== undefined
      expect(joined && now.band.join() === was.band.join(), `row ${i} joins`).toBe(false)
      // Ink inside the run's cells, none spilling over a neighbour...
      expect(!joined || now.left >= from * cell.width, `row ${i} left`).toBe(true)
      expect(!joined || now.right <= to * cell.width, `row ${i} right ${now.right}`).toBe(true)
      // ...and the run fills them, not cut short or squeezed small.
      expect(!joined || now.right - now.left > (to - from - 1) * cell.width, `row ${i} width`).toBe(
        true,
      )
    }

    // Off again: every pixel as before, the run split back into cells.
    off.view.setLigatures(false)
    const back = await read(off.element)
    expect(back.data).toEqual(before.data)
  })

  it.runIf(ratio === 1)("draws a long run as the DOM renderer draws it, not mangled", async () => {
    const webgl = await open("webgl", true)
    const dom = await open("dom", true)
    const cell = cellOf(webgl.view)
    const here = await read(webgl.element)
    const there = await read(dom.element)
    const long = rows.findIndex((row) => row.text.includes("=========="))
    const a = rowInk(here, long, cell.height)
    const b = rowInk(there, long, cell.height)
    // Both draw the font's own ten-cell bar; allow a pixel for the two rasterizers.
    expect(Math.abs(a.left - b.left)).toBeLessThanOrEqual(1)
    expect(Math.abs(a.right - b.right)).toBeLessThanOrEqual(1)
  })

  it("draws long bars to their ends, many lengths and colours, not past the glyph atlas", async () => {
    // A joined run is one glyph, and every length, colour and weight of one is its own, which
    // a run past 512 device pixels sent to an overflow page that holds about eighty: the frames
    // after drew nothing. Long runs are cut, so none is that wide.
    const bars = Array.from({ length: 16 }, (_, i) => {
      const colour = 31 + (i % 6)
      return `\x1b[${colour}m[${"=".repeat(96 + 7 * i)}>\x1b[0m ${i}%`
    })
    const layout = { lines: ["=".repeat(180), ...bars], cols: 220 }
    const { view, element } = await open("webgl", true, layout)
    const cell = cellOf(view)
    const pixels = await read(element)
    layout.lines.forEach((line, i) => {
      const ink = rowInk(pixels, i, cell.height)
      // Ink to the last glyph of the bar (a `>` or `=`), each of its cells.
      const end = i === 0 ? 180 : 96 + 7 * (i - 1) + 2
      expect(ink.right, `row ${i} reaches its end`).toBeGreaterThan((end - 1) * cell.width)
      expect(ink.right, `row ${i} stays in its cells`).toBeLessThanOrEqual(
        (i === 0 ? 180 : end + 5 + String(i - 1).length) * cell.width,
      )
    })
  })
})
