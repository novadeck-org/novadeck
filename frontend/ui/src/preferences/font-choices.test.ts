import { describe, expect, it } from "../test"
import { builtInFont, fontChoices } from "./font-choices"
import { noFonts } from "./local-fonts"

const installed = { monospace: ["Fira Code", "Menlo"], other: ["Arial"] }

describe("fontChoices", () => {
  it("starts with the built-in font, then the monospaced families, then the others marked", () => {
    const { items } = fontChoices(installed, "")

    expect(items.map((item) => item.value)).toEqual([builtInFont, "Fira Code", "Menlo", "Arial"])
    expect(items[0]).toMatchObject({ label: "JetBrains Mono", description: "Built in" })
    expect(items[3]).toMatchObject({ description: "Not monospace" })
  })

  it("chooses the built-in font when none is saved", () => {
    expect(fontChoices(installed, "").value).toBe(builtInFont)
  })

  it("chooses a saved family the computer lists", () => {
    expect(fontChoices(installed, "Menlo").value).toBe("Menlo")
  })

  it("falls back to the built-in font for a saved family that is no longer installed", () => {
    const { items, value } = fontChoices(installed, "Gone Mono")

    expect(value).toBe(builtInFont)
    expect(items.map((item) => item.value)).not.toContain("Gone Mono")
  })

  it("keeps the saved family as the choice where the computer lists no fonts, as it draws", () => {
    const { items, value } = fontChoices(noFonts, "Menlo")

    expect(value).toBe("Menlo")
    expect(items.map((item) => item.value)).toEqual([builtInFont, "Menlo"])
  })

  it("offers only the built-in font where the computer lists no fonts and none is saved", () => {
    expect(fontChoices(noFonts, "").items.map((item) => item.value)).toEqual([builtInFont])
  })
})
