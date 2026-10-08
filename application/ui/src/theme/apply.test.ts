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
import { themes } from "./themes"

const graphite = (scheme: "light" | "dark") => ({ theme: "graphite", scheme })

// A boot record as the app saves it, with its version and the theme's schemes.
const record = (theme: string, scheme: string, schemes: string[]) =>
  JSON.stringify({ v: 2, theme, scheme, schemes })

describe("resolveAppearance", () => {
  it("shows the chosen scheme of a theme that has it", () => {
    expect(resolveAppearance({ theme: "graphite", scheme: "dark" }, false, themes)).toEqual(
      graphite("dark"),
    )
    expect(resolveAppearance({ theme: "graphite", scheme: "light" }, true, themes)).toEqual(
      graphite("light"),
    )
  })

  context("when the scheme follows the system", () => {
    it("uses the system's scheme", () => {
      expect(resolveAppearance({ theme: "graphite", scheme: "system" }, true, themes)).toEqual(
        graphite("dark"),
      )
      expect(resolveAppearance({ theme: "graphite", scheme: "system" }, false, themes)).toEqual(
        graphite("light"),
      )
    })
  })

  context("when the theme has only a dark scheme", () => {
    it("shows dark whatever was chosen or the system uses", () => {
      for (const scheme of ["system", "light", "dark"] as const)
        for (const systemDark of [false, true])
          expect(
            resolveAppearance({ theme: "phosphor-green", scheme }, systemDark, themes),
          ).toEqual({
            theme: "phosphor-green",
            scheme: "dark",
          })
    })
  })

  it("falls back to the default theme when the theme is unknown", () => {
    expect(resolveAppearance({ theme: "sandstone", scheme: "dark" }, false, themes)).toEqual(
      graphite("dark"),
    )
  })
})

describe("appearancePreferenceOf", () => {
  it("keeps a valid saved theme and scheme", () => {
    expect(appearancePreferenceOf({ theme: "phosphor-green", scheme: "light" }, themes)).toEqual({
      theme: "phosphor-green",
      scheme: "light",
    })
  })

  it("keeps the mode a one-scheme theme overrides, for when the person switches back", () => {
    const saved = appearancePreferenceOf({ theme: "phosphor-green", scheme: "light" }, themes)

    expect(resolveAppearance(saved, false, themes).scheme).toBe("dark")
    expect(resolveAppearance({ ...saved, theme: "graphite" }, false, themes).scheme).toBe("light")
  })

  it("gives a preference without a theme the default theme and keeps its scheme", () => {
    expect(appearancePreferenceOf({ scheme: "dark" }, themes)).toEqual(graphite("dark"))
  })

  it("keeps a well-formed id the app does not know, which shows as the default theme", () => {
    for (const theme of ["sandstone", "ember", "a-theme-from-a-newer-version"]) {
      const saved = appearancePreferenceOf({ theme, scheme: "light" }, themes)

      expect(saved).toEqual({ theme, scheme: "light" })
      expect(resolveAppearance(saved, false, themes)).toEqual(graphite("light"))
    }
  })

  it("gives a malformed theme the default theme and keeps the scheme", () => {
    for (const theme of [3, null, "", "Graphite", "graph ite", "red; background:url(x)"])
      expect(appearancePreferenceOf({ theme, scheme: "dark" }, themes)).toEqual(graphite("dark"))
  })

  it("replaces an invalid scheme with the system's", () => {
    expect(appearancePreferenceOf({ theme: "phosphor-green", scheme: "dim" }, themes)).toEqual({
      theme: "phosphor-green",
      scheme: "system",
    })
    expect(appearancePreferenceOf({ scheme: 2 }, themes).scheme).toBe("system")
  })

  it("is the default when nothing was saved", () => {
    expect(appearancePreferenceOf(undefined, themes)).toEqual(defaultPreference(themes))
    expect(appearancePreferenceOf("dark", themes)).toEqual(defaultPreference(themes))
    expect(defaultPreference(themes)).toEqual({ theme: "graphite", scheme: "system" })
  })
})

describe("parseBootRecord", () => {
  it("reads the theme and scheme", () => {
    expect(parseBootRecord(record("phosphor-green", "system", ["dark"]), themes)).toEqual({
      theme: "phosphor-green",
      scheme: "system",
    })
  })

  it("gives a record without a theme the default theme", () => {
    expect(parseBootRecord(JSON.stringify({ scheme: "dark" }), themes)).toEqual(graphite("dark"))
  })

  it("reads a theme the app does not have, as the boot script does", () => {
    expect(parseBootRecord(record("sandstone", "dark", ["light"]), themes)).toEqual({
      theme: "sandstone",
      scheme: "dark",
    })
  })

  it("gives a record an older version saved, with a theme since retired, the default", () => {
    // Versions before the record's version saved the same fields, Sandstone among them.
    expect(
      parseBootRecord(
        JSON.stringify({ theme: "sandstone", scheme: "dark", schemes: ["light"] }),
        themes,
      ),
    ).toEqual({ theme: "graphite", scheme: "dark" })
  })

  it("gives a record without usable schemes the default theme", () => {
    for (const schemes of [undefined, [], ["dim"], "dark"])
      expect(
        parseBootRecord(
          JSON.stringify({ v: 2, theme: "phosphor-green", scheme: "dark", schemes }),
          themes,
        ),
      ).toEqual(graphite("dark"))
  })

  it("ignores a missing or malformed record", () => {
    expect(parseBootRecord(null, themes)).toBeUndefined()
    expect(parseBootRecord("{", themes)).toBeUndefined()
    expect(parseBootRecord("null", themes)).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ scheme: "dim" }), themes)).toBeUndefined()
    expect(parseBootRecord(JSON.stringify({ theme: "graphite" }), themes)).toBeUndefined()
  })
})

describe("startingAppearance", () => {
  context("without a boot record", () => {
    it("is the default theme in the system's scheme", () => {
      expect(startingAppearance(window, themes)).toEqual(graphite("light"))
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({ matches: query.includes("dark") }),
      })
      try {
        expect(startingAppearance(window, themes)).toEqual(graphite("dark"))
      } finally {
        delete (window as { matchMedia?: unknown }).matchMedia
      }
    })
  })

  it("follows a saved boot record", () => {
    localStorage.setItem(bootRecordKey, record("graphite", "dark", ["light", "dark"]))
    try {
      expect(startingAppearance(window, themes)).toEqual(graphite("dark"))
    } finally {
      localStorage.removeItem(bootRecordKey)
    }
  })

  it("shows a one-scheme theme in its scheme", () => {
    localStorage.setItem(bootRecordKey, record("phosphor-green", "light", ["dark"]))
    try {
      expect(startingAppearance(window, themes)).toEqual({
        theme: "phosphor-green",
        scheme: "dark",
      })
    } finally {
      localStorage.removeItem(bootRecordKey)
    }
  })

  it("keeps the mode of a record without a theme", () => {
    localStorage.setItem(bootRecordKey, JSON.stringify({ scheme: "dark" }))
    try {
      expect(startingAppearance(window, themes)).toEqual(graphite("dark"))
    } finally {
      localStorage.removeItem(bootRecordKey)
    }
  })
})

const fresh = (): HTMLElement => document.createElement("html")

describe("applyAppearance", () => {
  it("takes back the ground the boot script painted", () => {
    const root = document.createElement("html")
    root.style.backgroundColor = "#102030"
    root.style.colorScheme = "dark"

    applyAppearance(root, { theme: "graphite", scheme: "dark" })

    expect(root.style.backgroundColor).toBe("")
    expect(root.style.colorScheme).toBe("")
  })

  it("marks the root with the theme and scheme and announces the change", () => {
    const root = fresh()
    const changes: unknown[] = []
    const listen = (event: Event): void => {
      changes.push((event as CustomEvent).detail)
    }
    window.addEventListener(themeChangeEvent, listen)
    try {
      applyAppearance(root, graphite("dark"))
    } finally {
      window.removeEventListener(themeChangeEvent, listen)
    }

    expect(root.dataset).toMatchObject({ theme: "graphite", scheme: "dark" })
    expect(changes).toEqual([graphite("dark")])
  })

  it("does not still transitions for the first scheme", () => {
    const root = fresh()
    applyAppearance(root, graphite("light"))

    expect(root.hasAttribute("data-scheme-switching")).toBe(false)
  })

  context("when a scheme is already shown", () => {
    it("applies the new scheme's styles at once, while transitions are still", () => {
      const root = fresh()
      applyAppearance(root, graphite("light"))
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

      applyAppearance(root, graphite("dark"))

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
      applyAppearance(root, graphite("light"))
      applyAppearance(root, graphite("dark"))

      expect(root.hasAttribute("data-scheme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-scheme-switching")).toBe(true)
      frame()
      expect(root.hasAttribute("data-scheme-switching")).toBe(false)
    })

    it("stills transitions and announces a change of theme alone", () => {
      vi.spyOn(window, "requestAnimationFrame").mockReturnValue(0)
      const root = fresh()
      applyAppearance(root, { theme: "phosphor-green", scheme: "dark" })
      const changes: Event[] = []
      const listen = (event: Event): void => {
        changes.push(event)
      }
      window.addEventListener(themeChangeEvent, listen)
      try {
        applyAppearance(root, graphite("dark"))
      } finally {
        window.removeEventListener(themeChangeEvent, listen)
      }

      expect(root.dataset.theme).toBe("graphite")
      expect(root.hasAttribute("data-scheme-switching")).toBe(true)
      expect(changes).toHaveLength(1)
    })

    it("does nothing when the appearance is unchanged", () => {
      const root = fresh()
      applyAppearance(root, graphite("light"))
      const changes: Event[] = []
      const listen = (event: Event): void => {
        changes.push(event)
      }
      window.addEventListener(themeChangeEvent, listen)
      try {
        applyAppearance(root, graphite("light"))
      } finally {
        window.removeEventListener(themeChangeEvent, listen)
      }

      expect(root.hasAttribute("data-scheme-switching")).toBe(false)
      expect(changes).toEqual([])
    })
  })
})
