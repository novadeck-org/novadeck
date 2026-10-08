import { afterEach, vi } from "vitest"

import type { WindowAppearance } from "../backend/port"
import type { PreferencesValue } from "../model/types"
import { context, describe, expect, it } from "../test"
import { bootRecordKey } from "../theme/apply"
import { releaseMs, watchAppearance } from "./appearance"
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
      preferences: {
        fontSize: 13,
        enabledViews: ["focus"],
        appearance,
        notifyFinished: true,
        ligatures: false,
        chatView: false,
      },
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
  root.removeAttribute("data-scheme-switching")
})

describe("watchAppearance", () => {
  it("saves the shown theme's ground in the boot record", () => {
    system(false)
    resolvesPaper()
    const ui = uiWith({ theme: "graphite", scheme: "light" })
    watch(ui)

    expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
      v: 2,
      theme: "graphite",
      scheme: "light",
      schemes: ["light", "dark"],
      ground: "#ffffff",
      groundScheme: "light",
    })

    choose(ui, { theme: "graphite", scheme: "dark" })

    expect(JSON.parse(localStorage.getItem(bootRecordKey)!).ground).toBe("#191c20")
  })

  it("saves no ground where the page has none to read", () => {
    system(false)
    watch(uiWith({ theme: "graphite", scheme: "light" }))

    expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).not.toHaveProperty("ground")
  })

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
      v: 2,
      theme: "graphite",
      scheme: "system",
      schemes: ["light", "dark"],
    })

    choose(ui, { theme: "graphite", scheme: "dark" })

    expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })
    expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
      v: 2,
      theme: "graphite",
      scheme: "dark",
      schemes: ["light", "dark"],
    })
  })

  context("in a window with a host", () => {
    it("reports the scheme for native parts and the paper the page paints", () => {
      system(true)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "graphite", scheme: "system" })
      watch(ui, (look) => reports.push(look))

      choose(ui, { theme: "graphite", scheme: "light" })

      // While the page follows the system, native parts do too; a named scheme pins them
      // to it.
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

  context("in a window with a host, going back to the system from a pinned scheme", () => {
    // A pinned window makes `prefers-color-scheme` report the pin: dark here, while the
    // system itself is light.
    it("releases the window first, then shows the system's scheme as it arrives", () => {
      const { change } = system(true)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
      watch(ui, (look) => reports.push(look))

      choose(ui, { theme: "graphite", scheme: "system" })

      expect(reports.map((look) => look.scheme)).toEqual(["dark", "system"])
      expect(shown()).toEqual({ theme: "phosphor-green", scheme: "dark" })

      change(false)

      expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
    })

    it("shows it after a moment when the system's scheme was the pinned one", () => {
      vi.useFakeTimers()
      try {
        system(true)
        resolvesPaper()
        const reports: WindowAppearance[] = []
        const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
        watch(ui, (look) => reports.push(look))

        choose(ui, { theme: "graphite", scheme: "system" })

        // Released, but still showing and saving what it showed.
        expect(shown()).toEqual({ theme: "phosphor-green", scheme: "dark" })
        expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
          v: 2,
          theme: "phosphor-green",
          scheme: "system",
          schemes: ["dark"],
          ground: "#191c20",
          groundScheme: "dark",
        })

        vi.advanceTimersByTime(releaseMs)

        expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })
        expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
          v: 2,
          theme: "graphite",
          scheme: "system",
          schemes: ["light", "dark"],
          ground: "#191c20",
          groundScheme: "dark",
        })
        expect(reports.map((look) => look.scheme)).toEqual(["dark", "system", "system"])
      } finally {
        vi.useRealTimers()
      }
    })

    it("shows the latest choice when another comes while it waits", () => {
      vi.useFakeTimers()
      try {
        system(true)
        resolvesPaper()
        const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
        watch(ui, () => {})

        choose(ui, { theme: "graphite", scheme: "system" })
        choose(ui, { theme: "graphite", scheme: "light" })

        expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
        vi.advanceTimersByTime(releaseMs)
        expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
      } finally {
        vi.useRealTimers()
      }
    })

    it("waits afresh when it is pinned and released again before the first wait ends", () => {
      vi.useFakeTimers()
      try {
        system(true)
        resolvesPaper()
        const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
        watch(ui, () => {})

        choose(ui, { theme: "graphite", scheme: "system" })
        vi.advanceTimersByTime(releaseMs / 2)
        choose(ui, { theme: "graphite", scheme: "light" })
        choose(ui, { theme: "graphite", scheme: "system" })
        vi.advanceTimersByTime(releaseMs / 2)

        // The first wait would have ended here; only the second one counts.
        expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
        vi.advanceTimersByTime(releaseMs / 2)
        expect(shown()).toEqual({ theme: "graphite", scheme: "dark" })
      } finally {
        vi.useRealTimers()
      }
    })

    it("pins the window again when a scheme is named while it waits", () => {
      system(true)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "graphite", scheme: "dark" })
      watch(ui, (look) => reports.push(look))

      choose(ui, { theme: "graphite", scheme: "system" })
      choose(ui, { theme: "graphite", scheme: "dark" })

      expect(reports.map((look) => look.scheme)).toEqual(["dark", "system", "dark"])
    })

    it("shows nothing more once stopped while it waits", () => {
      vi.useFakeTimers()
      try {
        system(true)
        resolvesPaper()
        const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
        const stop = watchAppearance(ui, window, () => {})

        choose(ui, { theme: "graphite", scheme: "system" })
        stop()
        vi.advanceTimersByTime(releaseMs)

        expect(shown()).toEqual({ theme: "phosphor-green", scheme: "dark" })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  context("with a theme that has only a dark scheme", () => {
    it("shows it dark whatever the system does, and saves the mode chosen", () => {
      const { change } = system(false)
      watch(uiWith({ theme: "phosphor-green", scheme: "light" }))
      expect(shown()).toEqual({ theme: "phosphor-green", scheme: "dark" })

      change(true)
      change(false)

      expect(shown()).toEqual({ theme: "phosphor-green", scheme: "dark" })
      expect(JSON.parse(localStorage.getItem(bootRecordKey)!)).toEqual({
        v: 2,
        theme: "phosphor-green",
        scheme: "light",
        schemes: ["dark"],
      })
    })

    it("gives the window a dark scheme of its own, not the system's", () => {
      system(false)
      resolvesPaper()
      const reports: WindowAppearance[] = []
      const ui = uiWith({ theme: "phosphor-green", scheme: "system" })
      watch(ui, (look) => reports.push(look))

      choose(ui, { theme: "graphite", scheme: "system" })

      expect(reports.map((look) => look.scheme)).toEqual(["dark", "system"])
    })
  })

  it("stops following the preference and the system once stopped", () => {
    const { change, listeners } = system(false)
    const reports: WindowAppearance[] = []
    resolvesPaper()
    const ui = uiWith({ theme: "graphite", scheme: "system" })
    const stop = watchAppearance(ui, window, (look) => reports.push(look))

    stop()
    choose(ui, { theme: "graphite", scheme: "dark" })
    change(true)

    expect(listeners.size).toBe(0)
    expect(shown()).toEqual({ theme: "graphite", scheme: "light" })
    expect(reports).toHaveLength(1)
  })
})
