import { describe, expect, it } from "../test"
import { schemeCountOfTheme, themes } from "./themes"

describe("a theme's schemes", () => {
  it("counts the schemes a theme is drawn in, so one drawn in one leaves nothing to pick", () => {
    expect(schemeCountOfTheme("phosphor-green")).toBe(1)
    expect(schemeCountOfTheme(themes[0].id)).toBe(2)
  })

  it("counts the shown theme's for an id the app doesn't know", () => {
    expect(schemeCountOfTheme("no-such-theme")).toBe(themes[0].schemes.length)
  })
})
