import { context, describe, expect, it } from "../test"
import { hexColor, tokenColors } from "./probe"

describe("hexColor", () => {
  it("reads the colours getComputedStyle reports", () => {
    expect(hexColor(document, "rgb(242, 243, 245)")).toBe("#f2f3f5")
    expect(hexColor(document, "rgba(0, 0, 0, 0.5)")).toBe("#00000080")
    expect(hexColor(document, "rgb(15 17 20 / 100%)")).toBe("#0f1114")
  })

  it("reads what a color-mix() in sRGB computes to", () => {
    expect(hexColor(document, "color(srgb 1 0.5 0)")).toBe("#ff8000")
    expect(hexColor(document, "color(srgb 0 0 0 / 0.25)")).toBe("#00000040")
  })

  context("when the value is not a colour", () => {
    it("resolves nothing", () => {
      expect(hexColor(document, "")).toBeUndefined()
      expect(hexColor(document, "var(--terminal-bg)")).toBeUndefined()
      expect(hexColor(document, "inherit")).toBeUndefined()
    })
  })
})

describe("tokenColors", () => {
  it("leaves nothing behind in the scope it probes", () => {
    const scope = document.createElement("div")
    document.body.append(scope)
    try {
      tokenColors(scope, ["--terminal-bg", "--color-canvas"])
      expect(scope.childElementCount).toBe(0)
    } finally {
      scope.remove()
    }
  })

  // jsdom resolves no var(); the behaviour specs see real colours.
  it("leaves out tokens the document cannot resolve", () => {
    expect(tokenColors(document.body, ["--color-canvas"])).toEqual({})
  })
})
