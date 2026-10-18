import { act, createElement, type ComponentProps } from "react"
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

const show = async (addons: Partial<ComponentProps<typeof Preferences>>): Promise<void> => {
  const page = render(
    createElement(Preferences, {
      open: true,
      tab: "addons",
      onTabChange: () => {},
      value: readPreferences(),
      onChange: () => {},
      onClose: () => {},
      ...addons,
    }),
  )
  mounted.push(page)
  // The tabs' segment group measures its indicator a frame later: let that frame pass here.
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

const tabs = (): string[] =>
  [...document.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? "")
const selected = (): string | null =>
  document.querySelector('[role="tab"][aria-selected="true"]')?.textContent ?? null

describe("the preferences of a backend with no addons", () => {
  it("opens General, not the Addons panel, when a URL names Addons", async () => {
    await show({})

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("General")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).toBeNull()
  })

  it("still opens Addons where the backend reads conversations", async () => {
    await show({ chat: true })

    expect(selected()).toBe("Addons")
    expect(document.querySelector('[role="tabpanel"][aria-labelledby$="addons"]')).not.toBeNull()
  })
})
