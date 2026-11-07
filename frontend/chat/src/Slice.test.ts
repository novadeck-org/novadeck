import type { ChatSlice, ChatSliceRun } from "@novadeck/core/conversation"
import { paletteColour } from "@novadeck/core/conversation/slice"
import { render } from "@novadeck/test-kit/render"
import { createElement } from "react"

import { Slice } from "./Slice"
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
