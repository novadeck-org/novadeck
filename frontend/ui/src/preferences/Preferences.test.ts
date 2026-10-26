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

describe("the About tab", () => {
  it("is absent where the backend has no version, updates, logs or removal", async () => {
    await show({ tab: "about" })

    expect(tabs()).not.toContain("About")
    expect(selected()).toBe("General")
  })

  it("holds the version, the Experimental switch and the logs, which General doesn't", async () => {
    await show({
      tab: "about",
      version: "0.4.2",
      logs: () => {},
      experimental: { on: false, onChange: () => {} },
    })

    expect(selected()).toBe("About")
    const panel = document.querySelector('[role="tabpanel"][aria-labelledby$="about"]')
    expect(panel?.textContent).toContain("0.4.2")
    expect(
      panel?.querySelector('[role="switch"][aria-labelledby="experimental-label"]'),
    ).not.toBeNull()
    expect(panel?.textContent).toContain("Open logs folder")
    const general = document.querySelector('[role="tabpanel"][aria-labelledby$="general"]')
    expect(general?.textContent).not.toContain("0.4.2")
    expect(general?.textContent).not.toContain("Experimental")
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

describe("the Appearance tab", () => {
  const panel = (): Element | null =>
    document.querySelector('[role="tabpanel"][aria-labelledby$="appearance"]')

  it("comes right after General, and a URL naming it opens it", async () => {
    await show({ tab: "appearance" })

    expect(tabs().slice(0, 2)).toEqual(["General", "Appearance"])
    expect(selected()).toBe("Appearance")
  })

  it("holds the theme alone where the backend shows no desktop notifications", async () => {
    await show({ tab: "appearance" })

    expect(panel()?.textContent).toContain("Theme")
    expect(panel()?.textContent).not.toContain("Notification sound")
    expect(panel()?.textContent).not.toContain("Hear it")
  })

  it("holds the sound, led by the theme's own, where it does", async () => {
    await show({ tab: "appearance", notices: true })

    expect(panel()?.textContent).toContain("Notification sound")
    expect(panel()?.textContent).toContain("Theme's sound (Felt)")
    expect(panel()?.textContent).toContain("Hear it")
  })

  it("names the sound of the theme in effect", async () => {
    await show({
      tab: "appearance",
      notices: true,
      value: {
        ...readPreferences(),
        appearance: { theme: "phosphor-green", scheme: "dark" },
      },
    })

    expect(panel()?.textContent).toContain("Theme's sound (Afterglow)")
  })
})
