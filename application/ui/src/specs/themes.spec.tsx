import { afterEach, describe, expect, it } from "vitest"

const root = document.documentElement

// What the page computes for a custom property, with this theme and scheme on <html>.
const tokenIn = (theme: string | null, scheme: "light" | "dark", token: string): string => {
  if (theme === null) root.removeAttribute("data-theme")
  else root.dataset.theme = theme
  root.dataset.scheme = scheme
  return getComputedStyle(root).getPropertyValue(token).trim()
}

afterEach(() => {
  root.dataset.theme = "graphite"
  root.dataset.scheme = "light"
})

describe("theme scoping", () => {
  it("draws Graphite when no theme is set and when it is named", () => {
    for (const scheme of ["light", "dark"] as const)
      for (const token of ["--color-paper", "--color-strong", "--sidebar-create-border-color"]) {
        const named = tokenIn("graphite", scheme, token)
        expect(named, `${token} in ${scheme}`).not.toBe("")
        expect(tokenIn(null, scheme, token)).toBe(named)
      }
    expect(tokenIn("graphite", "light", "--color-paper")).not.toBe(
      tokenIn("graphite", "dark", "--color-paper"),
    )
  })

  it("keeps Graphite's component tokens out of another theme", () => {
    expect(tokenIn("phosphor-green", "dark", "--color-paper")).not.toBe(
      tokenIn("graphite", "dark", "--color-paper"),
    )
    expect(tokenIn("phosphor-green", "dark", "--sidebar-create-border-color")).toBe("")
  })
})
