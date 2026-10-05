import { afterEach, vi } from "vitest"

import type { WindowAppearance } from "../backend/port"
import type { PreferencesValue } from "../model/types"
import { context, describe, expect, it } from "../test"
import { bootRecordKey } from "../theme/apply"
import { watchAppearance } from "./appearance"
import { createUiStore, initialUi, type UiStore } from "./ui-store"

const root = document.documentElement

// The system's colour scheme, as `matchMedia` reports it, and a way to change it.
const system = (dark: boolean) => {
  const listeners = new Set<() => void>()
  const media = {
    matches: dark,
    addEventListener: (_: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_: string, listener: () => void) => listeners.delete(listener),
  }
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => {
      expect(query).toBe("(prefers-color-scheme: dark)")
      return media
    },
  })
  return {
    listeners,
    change: (next: boolean): void => {
      media.matches = next
      listeners.forEach((listener) => listener())
    },
  }
}

// jsdom resolves no `var()`: the page's paper is resolved here as a browser would, from
// the scheme on <html>.
const paper = { light: "rgb(255, 255, 255)", dark: "rgb(25, 28, 32)" }
const resolvesPaper = (): void => {
  const resolve = window.getComputedStyle.bind(window)
  vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
    if ((element as HTMLElement).style?.color !== "var(--color-paper)")
      return resolve(element, pseudo)
    const color = paper[root.dataset.scheme as "light" | "dark"]
    return {
      color,
      getPropertyValue: (name: string) => (name === "--color-paper" ? color : ""),
    } as unknown as CSSStyleDeclaration
  })
}

const uiWith = (appearance: PreferencesValue["appearance"]): UiStore =>
  createUiStore(
    initialUi({
      location: {
        route: {
          projectId: "project",
          sessionId: "session",
          view: "focus",
          terminal: "",
          panel: "terminals",
          dialog: null,
          section: "general",
        },
        dialogDepth: 0,
        navigationType: "POP",
      },
      preferences: { fontSize: 13, enabledViews: ["focus"], appearance, notifyFinished: true },
    }),
  )

const choose = (ui: UiStore, appearance: PreferencesValue["appearance"]): void =>
  void ui.update((state) => ({ ...state, preferences: { ...state.preferences, appearance } }))

const shown = () => ({ theme: root.dataset.theme, scheme: root.dataset.scheme })

const stops: (() => void)[] = []
const watch = (ui: UiStore, report?: (look: WindowAppearance) => void): void =>
  void stops.push(watchAppearance(ui, window, report))

afterEach(() => {
  stops.splice(0).forEach((stop) => stop())
  delete (window as { matchMedia?: unknown }).matchMedia
  localStorage.removeItem(bootRecordKey)
  root.removeAttribute("data-theme")
  root.removeAttribute("data-scheme")
  root.removeAttribute("data-theme-switching")
})

describe("watchAppearance", () => {
  context("while the preference follows the system", () => {
    it("shows the system's scheme, and changes with it", () => {
      const { change } = system(true)
      watch(uiWith({ theme: "graphite", scheme: "system" }))
      expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })

      change(false)

      expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
    })
  })

  context("while the preference names a scheme", () => {
    it("keeps it whatever the system does", () => {
      const { change } = system(false)
      watch(uiWith({ theme: "graphite", scheme: "dark" }))
      expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })

      change(true)
      change(false)

      expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })
    })
  })

  it("shows a new preference and saves what the boot script needs", () => {
    system(false)
    const ui = uiWith({ theme: "graphite", scheme: "system" })
    watch(ui)
    expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
      theme: "graphite",
      scheme: "system",
      schemes: ["light", "dark"],
    })

    choose(ui, { theme: "sandstone", scheme: "dark" })

    expect(shown()).toEqual({ theme: "sandstone", scheme: "light" })
    expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
      theme: "sandstone",
      scheme: "dark",
      schemes: ["light"],
    })
  })

  context("in a window with a host", () => {
    it("reports the scheme for native parts and the paper the page paints", () => {
      system(true)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "graphite", scheme: "system" })
      watch(ui, (look) => reports.push(look))

      choose(ui, { theme: "sandstone", scheme: "system" })

      // While the page follows the system, native parts do too; a theme with one scheme
      // pins them to it.
      expect(reports).toEqual([
        { scheme: "system", ground: "#191c20" },
        { scheme: "light", ground: "#ffffff" },
      ])
    })

    it("reports only what changed", () => {
      const { change } = system(false)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "graphite", scheme: "light" })
      watch(ui, (look) => reports.push(look))

      change(true)
      choose(ui, { theme: "graphite", scheme: "light" })

      expect(reports).toEqual([{ scheme: "light", ground: "#ffffff" }])
    })
  })

  it("stops following the preference and the system once stopped", () => {
    const { change, listeners } = system(false)
    const reports: WindowAppearance[] = []
    resolvesPaper()
    const ui = uiWith({ theme: "graphite", scheme: "system" })
    const stop = watchAppearance(ui, window, (look) => reports.push(look))

    stop()
    choose(ui, { theme: "sandstone", scheme: "system" })
    change(true)

    expect(listeners.size).toBe(0)
    expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
    expect(reports).toHaveLength(1)
  })
})
