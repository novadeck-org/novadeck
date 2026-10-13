import { createElement } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
import { render, type Rendered } from "../test/render"
import { Preferences } from "./Preferences"
import { readPreferences } from "./preferences-storage"

// jsdom has no layout: observe no resizes.
vi.hoisted(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

const mounted: Rendered[] = []
afterEach(() => mounted.splice(0).forEach((page) => page.unmount()))

const show = (visitor: boolean) => {
  const page = render(
    createElement(Preferences, {
      open: true,
      tab: "addons",
      onTabChange: () => {},
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      visitor,
    }),
  )
  mounted.push(page)
}

const tabs = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "")
const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null

describe("the preferences of a visitor's demo", () => {
  it("opens General, not the Addons panel, when a URL names Addons", () => {
    show(true)

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("General")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).toBeNull()
  })

  it("still opens Addons elsewhere", () => {
    show(false)

    expect(selected()).toBe("Addons")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).not.toBeNull()
  })
})
