import { nextFrame, render, type Rendered } from "@novadeck/test-kit/render"
import { createElement, type ComponentProps } from "react"
import { afterEach, vi } from "vitest"

import { describe, expect, it } from "../test"
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
  await nextFrame()
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

  it("has no Addons tab for the chat view, which is in Experimental", async () => {
    await show({ chat: true })

    expect(tabs()).not.toContain("Addons")
    expect(selected()).toBe("General")
  })
})

describe("the Experimental tab", () => {
  const experimental = (on: boolean | undefined) => ({ on, onChange: () => {} })

  it("is absent while the Experimental switch is off, and a URL naming it opens General", async () => {
    await show({ tab: "experimental", experimental: experimental(false) })

    expect(tabs()).not.toContain("Experimental")
    expect(selected()).toBe("General")
  })

  it("is absent until the app has said whether the switch is on", async () => {
    await show({ tab: "experimental", experimental: experimental(undefined) })

    expect(tabs()).not.toContain("Experimental")
  })

  it("shows, last, while the switch is on, with the chat view", async () => {
    await show({ tab: "experimental", chat: true, experimental: experimental(true) })

    expect(tabs().at(-1)).toBe("Experimental")
    expect(selected()).toBe("Experimental")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="experimental"]')
    expect(
      panel?.querySelector('[role="switch"][aria-labelledby="chat-view-label"]'),
    ).not.toBeNull()
  })
})
