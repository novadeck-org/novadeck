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

  it("names the default after the font the theme draws: the built-in one, or the theme's own", () => {
    expect(fontChoices(installed, "").items[0]).toMatchObject({
      label: "JetBrains Mono",
      description: "Built in",
    })
    expect(fontChoices(installed, "", "Share Tech Mono").items[0]).toEqual({
      label: "Share Tech Mono",
      value: builtInFont,
      description: "Theme",
    })
  })

  it("leaves an installed JetBrains Mono out under the built-in entry, but not under a theme's own font", () => {
    const withJetBrains = { monospace: ["JetBrains Mono", "JetBrains Mono NL"], other: [] }

    expect(fontChoices(withJetBrains, "").items.map((item) => item.value)).toEqual([
      builtInFont,
      "JetBrains Mono NL",
    ])
    expect(
      fontChoices(withJetBrains, "", "Share Tech Mono").items.map((item) => item.value),
    ).toEqual([builtInFont, "JetBrains Mono", "JetBrains Mono NL"])
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
