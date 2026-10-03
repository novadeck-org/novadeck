import { vi } from "vitest"

import { context, describe, expect, it } from "../test"
import {
  applyAppearance,
  appearancePreferenceOf,
  bootRecordKey,
  bootRecordOf,
  defaultPreference,
  parseBootRecord,
  resolveAppearance,
  startingAppearance,
  themeChangeEvent,
} from "./apply"
import { themes, type ThemeManifest } from "./themes"

const manifest: ThemeManifest = [
  { id: "graphite", name: "Graphite", schemes: ["light", "dark"] },
  { id: "night", name: "Night", schemes: ["dark"] },
]

describe("resolveAppearance", () => {
  it("shows the chosen theme in the chosen scheme", () => {
    expect(resolveAppearance({ theme: "graphite", scheme: "dark" }, false, manifest)).toEqual({
      theme: "graphite",
      scheme: "dark",
    })
  })

  context("when the scheme follows the system", () => {
    it("uses the system's scheme", () => {
      expect(resolveAppearance({ theme: "graphite", scheme: "system" }, true, manifest)).toEqual({
        theme: "graphite",
        scheme: "dark",
      })
      expect(resolveAppearance({ theme: "graphite", scheme: "system" }, false, manifest)).toEqual({
        theme: "graphite",
        scheme: "light",
      })
    })
  })

  context("when the theme offers one scheme", () => {
    it("always uses that scheme", () => {
      expect(resolveAppearance({ theme: "night", scheme: "light" }, false, manifest)).toEqual({
        theme: "night",
        scheme: "dark",
      })
      expect(resolveAppearance({ theme: "night", scheme: "system" }, false, manifest)).toEqual({
        theme: "night",
        scheme: "dark",
      })
    })
  })

  context("when the theme is unknown", () => {
    it("falls back to the first theme, Graphite", () => {
      expect(themes[0].id).toBe("graphite")
      expect(resolveAppearance({ theme: "retired", scheme: "dark" }, false, themes)).toEqual({
        theme: "graphite",
        scheme: "dark",
      })
    })
  })
})

describe("appearancePreferenceOf", () => {
  it("keeps a valid saved preference", () => {
    expect(appearancePreferenceOf({ theme: "night", scheme: "light" }, manifest)).toEqual({
      theme: "night",
      scheme: "light",
    })
  })

  it("replaces an unknown theme with the first and an invalid scheme with the system's", () => {
    expect(appearancePreferenceOf({ theme: "retired", scheme: "dim" }, manifest)).toEqual({
      theme: "graphite",
      scheme: "system",
    })
    expect(appearancePreferenceOf({ theme: "night", scheme: 2 }, manifest)).toEqual({
      theme: "night",
      scheme: "system",
    })
  })

  it("is the default when nothing was saved", () => {
    expect(appearancePreferenceOf(undefined, manifest)).toEqual(defaultPreference(manifest))
    expect(appearancePreferenceOf("dark", manifest)).toEqual(defaultPreference(manifest))
    expect(defaultPreference(themes)).toEqual({ theme: "graphite", scheme: "system" })
  })
})

describe("bootRecordOf", () => {
  it("holds the theme, the chosen scheme and the schemes the theme offers", () => {
    expect(bootRecordOf({ theme: "night", scheme: "system" }, manifest)).toEqual({
      theme: "night",
      scheme: "system",
      schemes: ["dark"],
    })
  })

  it("names the first theme for an unknown one", () => {
    expect(bootRecordOf({ theme: "retired", scheme: "dark" }, manifest)).toEqual({
      theme: "graphite",
      scheme: "dark",
      schemes: ["light", "dark"],
    })
  })
})

describe("parseBootRecord", () => {
  it("reads the theme and the chosen scheme", () => {
    const record = JSON.stringify({ theme: "graphite", scheme: "system", schemes: ["light"] })
    expect(parseBootRecord(record)).toEqual({ theme: "graphite", scheme: "system" })
  })

  it("ignores a missing or malformed record", () => {
    expect(parseBootRecord(null)).toBeUndefined()
    expect(parseBootRecord("{")).toBeUndefined()
    expect(parseBootRecord("null")).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ theme: "graphite", scheme: "dim" }))).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ theme: 1, scheme: "light" }))).toBeUndefined()
  })
})

describe("startingAppearance", () => {
  context("without a boot record", () => {
    it("is Graphite in the system's scheme", () => {
      expect(startingAppearance(window, themes)).toEqual({ theme: "graphite", scheme: "light" })
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: query.includes("dark") }),
      })
      try {
        expect(startingAppearance(window, themes)).toEqual({ theme: "graphite", scheme: "dark" })
      } finally {
        delete (window as { matchMedia?: unknown }).matchMedia
      }
    })
  })

  it("follows a saved boot record", () => {
    localStorage.setItem(bootRecordKey, JSON.stringify({ theme: "graphite", scheme: "dark" }))
    try {
      expect(startingAppearance(window, themes)).toEqual({ theme: "graphite", scheme: "dark" })
    } finally {
      localStorage.removeItem(bootRecordKey)
    }
  })
})

const fresh = (): HTMLElement => document.createElement("html")

describe("applyAppearance", () => {
  it("marks the root with the theme and scheme and announces the change", () => {
    const root = fresh()
    const changes: unknown[] = []
    const listen = (event: Event): void => {
      changes.push((event as CustomEvent).detail)
    }
    window.addEventListener(themeChangeEvent, listen)
    try {
      applyAppearance(root, { theme: "graphite", scheme: "dark" })
    } finally {
      window.removeEventListener(themeChangeEvent, listen)
    }

    expect(root.dataset).toMatchObject({ theme: "graphite", scheme: "dark" })
    expect(changes).toEqual([{ theme: "graphite", scheme: "dark" }])
  })

  it("does not still transitions for the first theme", () => {
    const root = fresh()
    applyAppearance(root, { theme: "graphite", scheme: "light" })

    expect(root.hasAttribute("data-theme-switching")).toBe(false)
  })

  context("when a theme is already shown", () => {
    it("applies the new theme's styles at once, while transitions are still", () => {
      const root = fresh()
      applyAppearance(root, { theme: "graphite", scheme: "light" })
      // A style read is what makes the browser apply styles now rather than at the next
      // frame, after the stilling may have gone.
      const reads: string[] = []
      const read = window.getComputedStyle.bind(window)
      vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
        reads.push(
          `${root.dataset.scheme}${root.hasAttribute("data-theme-switching") ? ", still" : ""}`,
        )
        return read(element)
      })
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0)

      applyAppearance(root, { theme: "graphite", scheme: "dark" })

      expect(reads).toEqual(["dark, still"])
    })

    it("keeps transitions still until a frame has drawn the new theme", () => {
      const frames: FrameRequestCallback[] = []
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
      const frame = (): void => frames.splice(0).forEach((callback) => callback(0))
      const root = fresh()
      applyAppearance(root, { theme: "graphite", scheme: "light" })
      applyAppearance(root, { theme: "graphite", scheme: "dark" })

      expect(root.hasAttribute("data-theme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-theme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-theme-switching")).toBe(false)
    })

    it("does nothing when the appearance is unchanged", () => {
      const root = fresh()
      applyAppearance(root, { theme: "graphite", scheme: "light" })
      const changes: Event[] = []
      const listen = (event: Event): void => {
        changes.push(event)
      }
      window.addEventListener(themeChangeEvent, listen)
      try {
        applyAppearance(root, { theme: "graphite", scheme: "light" })
      } finally {
        window.removeEventListener(themeChangeEvent, listen)
      }

      expect(root.hasAttribute("data-theme-switching")).toBe(false)
      expect(changes).toEqual([])
    })
  })
})
