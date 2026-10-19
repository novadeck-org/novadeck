import { render } from "@novadeck/test-kit/render"
import { App } from "@novadeck/ui/app/App"
import { act, createElement } from "react"
import { beforeAll, vi } from "vitest"

import { createSpecBackend } from "./support/backend"
import { describe, expect, it } from "./test"

// jsdom has no layout: answer every media query as unmatched (a phone without motion
// preferences, which keeps the page off the desktop panel library) and observe no resizes.
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }),
  })
  // Nor a canvas: the terminals' emulator measures with the DOM.
  HTMLCanvasElement.prototype.getContext = () => null
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

// Holds both dialog chunks until the test releases them.
const chunks = vi.hoisted(() => {
  let release!: () => void
  const arrived = new Promise<void>((resolve) => (release = resolve))
  return { arrived, release }
})

vi.mock("@novadeck/ui/app/deferred-views", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@novadeck/ui/app/deferred-views")>()
  const { lazy } = await import("react")
  return {
    ...actual,
    // The views' chunks have nothing to do with these dialogs, and a preload still loading
    // when the test ends fails the run after it.
    preloadViews: () => {},
    TerminalSearch: lazy(() =>
      chunks.arrived
        .then(() => import("@novadeck/ui/search/TerminalSearch"))
        .then((module) => ({ default: module.TerminalSearch })),
    ),
    Preferences: lazy(() =>
      chunks.arrived
        .then(() => import("@novadeck/ui/preferences/Preferences"))
        .then((module) => ({ default: module.Preferences })),
    ),
  }
})

const press = (key: string, init: KeyboardEventInit): void =>
  act(() => {
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }))
  })

const dialog = (label: string): Element | null =>
  document.querySelector(`[role="dialog"][aria-label="${label}"]`)

describe("workspace dialogs that load on demand", () => {
  // Their modules load once up front, which can take a while on a slow machine; the
  // test is about the order the dialogs open in, not how long loading them takes.
  beforeAll(async () => {
    await import("@novadeck/ui/search/TerminalSearch")
    await import("@novadeck/ui/preferences/Preferences")
  }, 60_000)

  it("opens the dialog requested last when an earlier one never finished loading", async () => {
    window.location.hash = ""
    const app = render(createElement(App, { createBackend: createSpecBackend }))
    press("K", { ctrlKey: true, shiftKey: true })
    press(",", { ctrlKey: true })
    expect(window.location.hash).toContain("dialog=preferences")
    await act(async () => {
      chunks.release()
      await chunks.arrived
      await import("@novadeck/ui/search/TerminalSearch")
      await import("@novadeck/ui/preferences/Preferences")
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(dialog("Find a terminal")).toBeNull()
    expect(dialog("Preferences")).not.toBeNull()
    app.unmount()
  })
})
