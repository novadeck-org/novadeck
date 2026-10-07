import { vi } from "vitest"

import { context, describe, expect, it } from "../test"
import {
  applyAppearance,
  appearancePreferenceOf,
  bootRecordKey,
  defaultPreference,
  parseBootRecord,
  resolveAppearance,
  startingAppearance,
  themeChangeEvent,
} from "./apply"

describe("resolveAppearance", () => {
  it("shows the chosen scheme", () => {
    expect(resolveAppearance({ scheme: "dark" }, false)).toEqual({ scheme: "dark" })
    expect(resolveAppearance({ scheme: "light" }, true)).toEqual({ scheme: "light" })
  })

  context("when the scheme follows the system", () => {
    it("uses the system's scheme", () => {
      expect(resolveAppearance({ scheme: "system" }, true)).toEqual({ scheme: "dark" })
      expect(resolveAppearance({ scheme: "system" }, false)).toEqual({ scheme: "light" })
    })
  })
})

describe("appearancePreferenceOf", () => {
  it("keeps a valid saved scheme", () => {
    expect(appearancePreferenceOf({ scheme: "light" })).toEqual({ scheme: "light" })
  })

  it("ignores the theme older versions saved, even one the app never had", () => {
    expect(appearancePreferenceOf({ scheme: "dark" })).toEqual({
      scheme: "dark",
    })
    expect(appearancePreferenceOf({ theme: "sandstone", scheme: "light" })).toEqual({
      scheme: "light",
    })
  })

  it("replaces an invalid scheme with the system's", () => {
    expect(appearancePreferenceOf({ scheme: "dim" })).toEqual({ scheme: "system" })
    expect(appearancePreferenceOf({ scheme: 2 })).toEqual({ scheme: "system" })
  })

  it("is the default when nothing was saved", () => {
    expect(appearancePreferenceOf(undefined)).toEqual(defaultPreference)
    expect(appearancePreferenceOf("dark")).toEqual(defaultPreference)
    expect(defaultPreference).toEqual({ scheme: "system" })
  })
})

describe("parseBootRecord", () => {
  it("reads the chosen scheme", () => {
    expect(parseBootRecord(JSON.stringify({ scheme: "system" }))).toEqual({ scheme: "system" })
  })

  it("reads the record older versions saved, whatever theme and schemes it holds", () => {
    for (const theme of ["graphite", "sandstone"])
      expect(
        parseBootRecord(JSON.stringify({ theme, scheme: "dark", schemes: ["light"] })),
      ).toEqual({ scheme: "dark" })
  })

  it("ignores a missing or malformed record", () => {
    expect(parseBootRecord(null)).toBeUndefined()
    expect(parseBootRecord("{")).toBeUndefined()
    expect(parseBootRecord("null")).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ scheme: "dim" }))).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ theme: "graphite" }))).toBeUndefined()
  })
})

describe("startingAppearance", () => {
  context("without a boot record", () => {
    it("is the system's scheme", () => {
      expect(startingAppearance(window)).toEqual({ scheme: "light" })
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: query.includes("dark") }),
      })
      try {
        expect(startingAppearance(window)).toEqual({ scheme: "dark" })
      } finally {
        delete (window as { matchMedia?: unknown }).matchMedia
      }
    })
  })

  it("follows a saved boot record", () => {
    localStorage.setItem(bootRecordKey, JSON.stringify({ scheme: "dark" }))
    try {
      expect(startingAppearance(window)).toEqual({ scheme: "dark" })
    } finally {
      localStorage.removeItem(bootRecordKey)
    }
  })
})

const fresh = (): HTMLElement => document.createElement("html")

describe("applyAppearance", () => {
  it("marks the root with the scheme and announces the change", () => {
    const root = fresh()
    const changes: unknown[] = []
    const listen = (event: Event): void => {
      changes.push((event as CustomEvent).detail)
    }
    window.addEventListener(themeChangeEvent, listen)
    try {
      applyAppearance(root, { scheme: "dark" })
    } finally {
      window.removeEventListener(themeChangeEvent, listen)
    }

    expect(root.dataset.scheme).toBe("dark")
    expect(changes).toEqual([{ scheme: "dark" }])
  })

  it("does not still transitions for the first scheme", () => {
    const root = fresh()
    applyAppearance(root, { scheme: "light" })

    expect(root.hasAttribute("data-scheme-switching")).toBe(false)
  })

  context("when a scheme is already shown", () => {
    it("applies the new scheme's styles at once, while transitions are still", () => {
      const root = fresh()
      applyAppearance(root, { scheme: "light" })
      // A style read is what makes the browser apply styles now rather than at the next
      // frame, after the stilling may have gone.
      const reads: string[] = []
      const read = window.getComputedStyle.bind(window)
      vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
        reads.push(
          `${root.dataset.scheme}${root.hasAttribute("data-scheme-switching") ? ", still" : ""}`,
        )
        return read(element)
      })
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0)

      applyAppearance(root, { scheme: "dark" })

      expect(reads).toEqual(["dark, still"])
    })

    it("keeps transitions still until a frame has drawn the new scheme", () => {
      const frames: FrameRequestCallback[] = []
      vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
      const frame = (): void => frames.splice(0).forEach((callback) => callback(0))
      const root = fresh()
      applyAppearance(root, { scheme: "light" })
      applyAppearance(root, { scheme: "dark" })

      expect(root.hasAttribute("data-scheme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-scheme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-scheme-switching")).toBe(false)
    })

    it("does nothing when the appearance is unchanged", () => {
      const root = fresh()
      applyAppearance(root, { scheme: "light" })
      const changes: Event[] = []
      const listen = (event: Event): void => {
        changes.push(event)
      }
      window.addEventListener(themeChangeEvent, listen)
      try {
        applyAppearance(root, { scheme: "light" })
      } finally {
        window.removeEventListener(themeChangeEvent, listen)
      }

      expect(root.hasAttribute("data-scheme-switching")).toBe(false)
      expect(changes).toEqual([])
    })
  })
})
