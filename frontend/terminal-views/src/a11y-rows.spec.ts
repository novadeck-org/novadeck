import "@novadeck/emulator/browser.css"
import { createView, type Terminal } from "@novadeck/emulator/browser"
import { afterEach } from "vitest"

import { describe, expect, it } from "./test"

// With screen-reader mode on, xterm keeps a list of row elements that mirror the screen and
// aligns each one's width with a scaleX transform, which takes a layout to measure. The emulator
// patch rewrites only the rows whose text changed, and reads all their widths in one pass; an
// agent's TUI redrawing one row of a full screen no longer costs a layout per row.

const cols = 80
const rows = 24
const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((close) => close()))

// What xterm's render service fires on a change of dimensions or pixel ratio.
/* eslint-disable no-underscore-dangle -- Its only way out is its internals. */
const refreshDimensions = (xterm: Terminal) =>
  (
    xterm as unknown as {
      _core: { _accessibilityManager: { value: { _refreshRowsDimensions(): void } } }
    }
  )._core._accessibilityManager.value._refreshRowsDimensions()
/* eslint-enable no-underscore-dangle */

const frame = () => new Promise<void>((done) => requestAnimationFrame(() => done()))

const open = async () => {
  const wrap = document.createElement("div")
  wrap.style.cssText = "position: absolute; left: 0; top: 0; transform-origin: 0 0"
  const element = document.createElement("div")
  element.style.cssText = "width: 900px; height: 500px"
  wrap.append(element)
  document.body.append(wrap)
  const view = createView(element, {
    fontSize: 14,
    fontFamily: "monospace",
    theme: {},
    scrollback: 0,
  })
  const xterm = view.terminal
  xterm.options.screenReaderMode = true
  xterm.resize(cols, rows)
  closers.push(() => {
    view.dispose()
    wrap.remove()
  })
  const tree = element.querySelector<HTMLElement>(".xterm-accessibility-tree")!
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!
  const written = (data: string) => new Promise<void>((done) => xterm.write(data, done))
  // xterm renders on the next frame, and the tree follows at most once a second (its debouncer's
  // threshold), with a trailing refresh for what was throttled.
  const settled = async () => {
    await frame()
    await new Promise((done) => setTimeout(done, 1100))
  }
  const lines = Array.from({ length: rows }, (_, row) => `row ${row} ${"x".repeat(10 + row)}`)
  await written(lines.join("\r\n"))
  const items = () => [...tree.children] as HTMLElement[]
  await expect.poll(() => items().at(-1)?.textContent, { timeout: 5000 }).toBe(lines.at(-1))
  await settled()
  return { xterm, tree, wrap, screen, written, settled, items }
}

describe("a screen-reader terminal's rows", () => {
  it("lists a row per screen row, aligned to its cells", async () => {
    const { items, screen } = await open()
    const cell = screen.getBoundingClientRect().width / cols
    expect(items()).toHaveLength(rows)
    for (const [row, item] of items().entries()) {
      expect(item.textContent).toBe(`row ${row} ${"x".repeat(10 + row)}`)
      expect(item.style.transform).toMatch(/^scaleX\(/)
      expect(item.getBoundingClientRect().width).toBeCloseTo(item.textContent!.length * cell, 0)
    }
  })

  it("rewrites only the row that changed when a program redraws one row", async () => {
    const { xterm, tree, written, settled, items } = await open()
    const touched = new Set<Element>()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target
        touched.add(node instanceof Element ? node : node.parentElement!)
      }
    })
    observer.observe(tree, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    })
    closers.push(() => observer.disconnect())

    const redraw = async (tick: number) => {
      await written(`\x1b[6;1H\x1b[2Kticking ${tick} ${"y".repeat(20 + tick)}`)
      await settled()
    }
    await redraw(0)
    await redraw(1)
    await redraw(2)
    observer.takeRecords().forEach((record) => touched.add(record.target as Element))

    const changed = items()[5]!
    expect(touched).toEqual(new Set([changed]))
    expect(changed.textContent).toBe(`ticking 2 ${"y".repeat(22)}`)
    expect(changed.style.transform).toMatch(/^scaleX\(/)
    const cell = xterm.element!.querySelector(".xterm-screen")!.getBoundingClientRect().width / cols
    expect(changed.getBoundingClientRect().width).toBeCloseTo(changed.textContent!.length * cell, 0)
  })

  it("aligns every row again when the cell changes size", async () => {
    const { xterm, screen, settled, items } = await open()
    xterm.options.fontSize = 20
    await settled()
    const cell = screen.getBoundingClientRect().width / cols
    expect(cell).toBeGreaterThan(11)
    for (const item of items()) {
      expect(item.getBoundingClientRect().width).toBeCloseTo(item.textContent!.length * cell, 0)
    }
  })

  // The Canvas view scales a terminal with a CSS transform, which getBoundingClientRect includes:
  // a row aligned under one must not keep that alignment once the scale is gone.
  it("aligns a row right whatever scale its ancestors had when it was last aligned", async () => {
    const { xterm, wrap, screen, settled, items } = await open()
    // Aligns every row under half scale, as a dimensions change would while zoomed out.
    wrap.style.transform = "scale(0.5)"
    refreshDimensions(xterm)
    wrap.style.transform = ""
    // Same text, position and cell width: a full refresh must still leave the rows right.
    xterm.refresh(0, rows - 1)
    await settled()
    const cell = screen.getBoundingClientRect().width / cols
    for (const item of items()) {
      expect(item.getBoundingClientRect().width).toBeCloseTo(item.textContent!.length * cell, 0)
    }
  })

  it("aligns rows right at a scale, in a pass of their own", async () => {
    const { xterm, wrap, screen, items } = await open()
    wrap.style.transform = "scale(0.5)"
    refreshDimensions(xterm)
    const cell = screen.getBoundingClientRect().width / cols
    for (const item of items()) {
      expect(item.getBoundingClientRect().width).toBeCloseTo(item.textContent!.length * cell, 0)
    }
  })

  // A change of dimensions or pixel ratio runs the manager's _refreshRowsDimensions with the same
  // CSS cell and rows that rendering would skip, so only it can realign them.
  it("aligns every row on a dimensions refresh, rows unchanged", async () => {
    const { xterm, screen, items } = await open()
    for (const item of items()) item.style.transform = "scaleX(3)"
    refreshDimensions(xterm)
    const cell = screen.getBoundingClientRect().width / cols
    for (const item of items()) {
      expect(item.getBoundingClientRect().width).toBeCloseTo(item.textContent!.length * cell, 0)
    }
  })
})
