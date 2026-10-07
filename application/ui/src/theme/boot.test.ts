import { readFileSync } from "node:fs"
import { join } from "node:path"

import { afterEach, vi } from "vitest"

import { context, describe, expect, it } from "../test"
import {
  applyAppearance,
  bootRecordKey,
  defaultPreference,
  resolveAppearance,
  startingAppearance,
  type Appearance,
} from "./apply"

const script = readFileSync(join(process.cwd(), "public/theme-boot.js"), "utf8")

// Runs the boot script on a fresh <html> as the page would, with this much saved and
// the system in this scheme, and reads back what it set.
const boot = (saved: string | null, systemDark: boolean): Appearance => {
  const root = document.documentElement
  root.removeAttribute("data-scheme")
  root.removeAttribute("style")
  if (saved === null) localStorage.removeItem(bootRecordKey)
  else localStorage.setItem(bootRecordKey, saved)
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({ matches: systemDark && query === "(prefers-color-scheme: dark)" }),
  })
  // oxlint-disable-next-line no-new-func -- the script runs as the page runs it, as is
  new Function(script)()
  return { scheme: root.dataset.scheme as Appearance["scheme"] }
}

afterEach(() => {
  localStorage.removeItem(bootRecordKey)
  delete (window as { matchMedia?: unknown }).matchMedia
  document.documentElement.removeAttribute("data-scheme")
  document.documentElement.removeAttribute("data-scheme-switching")
  document.documentElement.removeAttribute("style")
})

const systems = [false, true]
const schemes = ["system", "light", "dark"] as const

describe("the boot script", () => {
  it("shows what apply.ts resolves for every choice it saves", () => {
    for (const scheme of schemes)
      for (const systemDark of systems) {
        const preference = { scheme }
        expect(boot(JSON.stringify(preference), systemDark)).toEqual(
          resolveAppearance(preference, systemDark),
        )
      }
  })

  it("gives <html> the scheme's color-scheme until the app shows the theme", () => {
    const root = document.documentElement
    boot(JSON.stringify({ scheme: "system" }), true)
    expect(root.style.colorScheme).toBe("dark")

    applyAppearance(root, startingAppearance(window))

    expect(root.style.colorScheme).toBe("")
  })

  context("with a record older versions saved", () => {
    it("shows its scheme, whatever theme and schemes it names", () => {
      for (const theme of ["graphite", "sandstone"])
        for (const scheme of schemes)
          for (const systemDark of systems) {
            const record = JSON.stringify({ theme, scheme, schemes: ["light"] })
            expect(boot(record, systemDark)).toEqual(resolveAppearance({ scheme }, systemDark))
          }
    })

    it("shows it as the app does at startup", () => {
      const root = document.documentElement
      const record = JSON.stringify({ theme: "sandstone", scheme: "dark", schemes: ["light"] })
      expect(boot(record, false)).toEqual({ scheme: "dark" })

      applyAppearance(root, startingAppearance(window))

      expect(root.dataset.scheme).toBe("dark")
    })
  })

  context("without a usable record", () => {
    const records = [
      null,
      "{",
      "null",
      "[]",
      JSON.stringify({ scheme: "dim" }),
      JSON.stringify({ theme: "graphite", scheme: 1, schemes: ["light", "dark"] }),
      JSON.stringify({ theme: "graphite" }),
    ]

    it("shows the system's scheme, as apply.ts would", () => {
      for (const record of records)
        for (const systemDark of systems)
          expect(boot(record, systemDark)).toEqual(resolveAppearance(defaultPreference, systemDark))
    })

    it("tolerates storage that throws", () => {
      vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
        throw new Error("denied")
      })
      expect(boot(null, true)).toEqual(resolveAppearance(defaultPreference, true))
    })
  })
})
