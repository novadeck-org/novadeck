import { themes } from "@novadeck/ui/theme/themes"
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
  root.dataset.theme = "coolant"
  root.dataset.scheme = "light"
})

describe("theme scoping", () => {
  it("draws Coolant when no theme is set and when it is named", () => {
    for (const scheme of ["light", "dark"] as const)
      for (const token of ["--color-paper", "--color-strong", "--sidebar-create-border-color"]) {
        const named = tokenIn("coolant", scheme, token)
        expect(named, `${token} in ${scheme}`).not.toBe("")
        expect(tokenIn(null, scheme, token)).toBe(named)
      }
    expect(tokenIn("coolant", "light", "--color-paper")).not.toBe(
      tokenIn("coolant", "dark", "--color-paper"),
    )
  })

  it("keeps Coolant's component tokens out of another theme", () => {
    expect(tokenIn("phosphor-green", "dark", "--color-paper")).not.toBe(
      tokenIn("coolant", "dark", "--color-paper"),
    )
    expect(tokenIn("phosphor-green", "dark", "--sidebar-create-border-color")).toBe("")
  })
})

// A selected item on the page, highlighted too where asked.
const selectedItem = (highlighted: boolean): HTMLElement => {
  const element = document.createElement("button")
  element.className = "item standalone"
  element.dataset.selected = "true"
  if (highlighted) element.dataset.highlighted = ""
  element.innerHTML =
    '<svg></svg><span>storefront</span><small class="item-detail">~/storefront</small>'
  document.body.append(element)
  return element
}

describe("a selected item", () => {
  it("keeps its own text when it is highlighted too, in every theme", () => {
    // Two selected items, one also highlighted, as the current project's row is under the
    // pointer or the keyboard.
    const plain = selectedItem(false)
    const lit = selectedItem(true)
    try {
      for (const theme of themes)
        for (const scheme of theme.schemes) {
          tokenIn(theme.id, scheme, "--color-paper")
          const where = `${theme.id} ${scheme}`
          const style = getComputedStyle(lit)
          expect(style.backgroundColor, where).toBe(getComputedStyle(plain).backgroundColor)
          expect(style.color, where).toBe(getComputedStyle(plain).color)
          for (const part of ["svg", ".item-detail"])
            expect(getComputedStyle(lit.querySelector(part)!).color, `${where} ${part}`).toBe(
              getComputedStyle(plain.querySelector(part)!).color,
            )
        }
    } finally {
      plain.remove()
      lit.remove()
    }
  })
})
