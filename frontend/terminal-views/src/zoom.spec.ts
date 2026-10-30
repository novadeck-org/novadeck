import "@novadeck/emulator/browser.css"
import { createView, loadWebgl, type Terminal } from "@novadeck/emulator/browser"
import { afterEach } from "vitest"

import { describe, expect, it } from "./test"

// A terminal inside a CSS-scaled container, as the Canvas view puts it at any zoom: a click or
// a drag must land on the cell under the pointer. xterm maps the pointer in client pixels,
// which the scale stretches, against cell sizes the scale doesn't touch.

const cols = 80
const rows = 24
const closers: (() => void)[] = []
afterEach(() => closers.splice(0).forEach((close) => close()))

const open = (scale: number, renderer: "dom" | "webgl") => {
  const wrap = document.createElement("div")
  wrap.style.cssText = `position: absolute; left: 100px; top: 60px; transform-origin: 0 0; transform: scale(${scale})`
  const element = document.createElement("div")
  wrap.append(element)
  document.body.append(wrap)
  const view = createView(element, {
    fontSize: 14,
    fontFamily: "monospace",
    theme: {},
    scrollback: 0,
  })
  const xterm: Terminal = view.terminal
  xterm.resize(cols, rows)
  if (renderer === "webgl") {
    const drawing = loadWebgl(xterm)
    closers.push(() => drawing.dispose())
  }
  closers.push(() => {
    view.dispose()
    wrap.remove()
  })
  const reports: string[] = []
  xterm.onData((data) => reports.push(data))
  const screen = element.querySelector<HTMLElement>(".xterm-screen")!
  const written = (data: string) => new Promise<void>((done) => xterm.write(data, done))
  // The client position of the middle of a cell, from the screen as the page lays it out.
  const centre = (col: number, row: number) => {
    const box = screen.getBoundingClientRect()
    return {
      clientX: box.left + ((col + 0.5) * box.width) / cols,
      clientY: box.top + ((row + 0.5) * box.height) / rows,
    }
  }
  const fire = (target: EventTarget, type: string, at: { clientX: number; clientY: number }) =>
    target.dispatchEvent(
      new MouseEvent(type, {
        ...at,
        bubbles: true,
        cancelable: true,
        detail: 1,
        button: 0,
        buttons: type === "mouseup" ? 0 : 1,
      }),
    )
  return { xterm, reports, screen, written, centre, fire }
}

const lines = Array.from({ length: rows }, (_, row) =>
  Array.from({ length: cols }, (__, col) => String.fromCharCode(65 + ((col + row) % 26))).join(""),
).join("\r\n")

const renderers = document.createElement("canvas").getContext("webgl2")
  ? (["dom", "webgl"] as const)
  : (["dom"] as const)

describe.each(renderers)("a terminal inside a scaled container, drawn with %s", (renderer) => {
  it.each([0.5, 1, 1.5])(
    "at scale %s reports a click at the cell under the pointer",
    async (scale) => {
      const { written, reports, screen, centre, fire } = open(scale, renderer)
      await written(`${lines}\x1b[?1000h\x1b[?1006h`)
      const at = centre(40, 3)
      fire(screen, "mousedown", at)
      fire(document, "mouseup", at)
      expect(reports).toEqual(["\x1b[<0;41;4M", "\x1b[<0;41;4m"])
    },
  )

  it.each([0.5, 1, 1.5])(
    "at scale %s selects from the cell the drag starts to the one it ends on",
    async (scale) => {
      const { xterm, written, screen, centre, fire } = open(scale, renderer)
      await written(lines)
      fire(screen, "mousedown", centre(10, 3))
      fire(document, "mousemove", centre(15, 3))
      fire(document, "mousemove", centre(19, 3))
      fire(document, "mouseup", centre(19, 3))
      expect(xterm.getSelectionPosition()).toEqual({ start: { x: 10, y: 3 }, end: { x: 19, y: 3 } })
    },
  )
})
