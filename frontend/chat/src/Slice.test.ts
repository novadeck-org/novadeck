import type { ChatSlice, ChatSliceRun } from "@novadeck/core/conversation"
import { paletteColour } from "@novadeck/core/conversation/slice"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { Slice, SliceKeys } from "./Slice"
import { describe, expect, it } from "./test"

const run = (text: string, fields: Partial<ChatSliceRun> = {}): ChatSliceRun => ({
  text,
  width: text.length,
  fg: null,
  bg: null,
  bold: false,
  dim: false,
  italic: false,
  underline: false,
  inverse: false,
  ...fields,
})

const slice = (rows: ChatSlice["rows"]): ChatSlice => ({
  reason: "menu",
  columns: 40,
  rows,
  cursor: null,
  secret: false,
})

describe("Slice", () => {
  it("draws the rows as they are, a blank row kept", async () => {
    const { container } = await render(
      createElement(Slice, { slice: slice([[run("/model"), run(" Set")], [], [run("end")]]) }),
    )
    const rows = [...container.querySelectorAll(".chat-slice > div")].map((row) => row.textContent)
    expect(rows).toEqual(["/model Set", " ", "end"])
  })

  it("carries a run's style", async () => {
    const { container } = await render(
      createElement(Slice, {
        slice: slice([[run("x", { fg: "#112233", bold: true, dim: true })]]),
      }),
    )
    const span = container.querySelector<HTMLElement>(".chat-slice span")!
    expect(span.style.color).toBe("rgb(17, 34, 51)")
    expect(span.style.fontWeight).toBe("700")
    expect(span.style.opacity).toBe("0.6")
  })

  it("swaps the colours of an inverse run", async () => {
    const { container } = await render(
      createElement(Slice, { slice: slice([[run("x", { inverse: true, fg: "#112233" })]]) }),
    )
    const span = container.querySelector<HTMLElement>(".chat-slice span")!
    expect(span.style.backgroundColor).toBe("rgb(17, 34, 51)")
  })

  it("keeps an inverse run of default colours readable", async () => {
    const { container } = await render(
      createElement(Slice, { slice: slice([[run("x", { inverse: true })]]) }),
    )
    const span = container.querySelector<HTMLElement>(".chat-slice span")!
    expect(span.getAttribute("style")).toContain("color: var(--terminal-bg)")
    expect(span.getAttribute("style")).toContain("background-color: var(--terminal-fg)")
  })
})

describe("a slice that takes the keys", () => {
  const live = (reason: ChatSlice["reason"], keys: (pressed: string) => void) =>
    render(
      createElement(
        SliceKeys.Provider,
        { value: keys },
        createElement(Slice, { slice: { ...slice([[run("x")]]), reason }, live: true }),
      ),
    )

  it("passes every key of a view, and takes focus", async () => {
    const pressed: string[] = []
    const { container } = await live("view", (keys) => pressed.push(keys))
    const element = container.querySelector<HTMLElement>(".chat-slice")!
    expect(document.activeElement).toBe(element)
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    expect(pressed).toEqual(["\x1b", "a"])
  })

  it("leaves what is selected to copy, and a modified key to the app", async () => {
    const pressed: string[] = []
    const { container } = await live("view", (keys) => pressed.push(keys))
    const element = container.querySelector<HTMLElement>(".chat-slice")!
    window.getSelection()?.selectAllChildren(element)
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true }))
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }))
    expect(pressed).toEqual(["c"])
    pressed.length = 0
    window.getSelection()?.removeAllRanges()
    element.dispatchEvent(
      new KeyboardEvent("keydown", { key: "T", ctrlKey: true, shiftKey: true, bubbles: true }),
    )
    expect(pressed).toEqual([])
  })

  it("leaves a menu's keys to the box", async () => {
    const pressed: string[] = []
    const { container } = await live("menu", (keys) => pressed.push(keys))
    const element = container.querySelector<HTMLElement>(".chat-slice")!
    expect(document.activeElement).not.toBe(element)
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }))
    expect(pressed).toEqual([])
  })
})

describe("paletteColour", () => {
  it("takes the sixteen from the terminal's theme", () => {
    expect(paletteColour(0)).toBe("var(--terminal-ansi-black)")
    expect(paletteColour(1)).toBe("var(--terminal-ansi-red)")
    expect(paletteColour(7)).toBe("var(--terminal-ansi-white)")
    expect(paletteColour(8)).toBe("var(--terminal-ansi-black-bright)")
    expect(paletteColour(15)).toBe("var(--terminal-ansi-white-bright)")
  })

  it("reads the cube and the grey ramp, which no theme changes", () => {
    expect(paletteColour(16)).toBe("#000000")
    expect(paletteColour(196)).toBe("#ff0000")
    expect(paletteColour(232)).toBe("#080808")
    expect(paletteColour(255)).toBe("#eeeeee")
  })
})
