import type { Scheme, SchemePreference } from "./scheme"
import type { ThemeManifest } from "./themes"

// What the person chose. The theme is a plain string until it is checked against the
// manifest, because a saved choice may name a theme the app no longer has.
export type AppearancePreference<Id extends string = string> = {
  readonly theme: Id
  readonly scheme: SchemePreference
}

// What the page shows: a theme the manifest has, in a scheme that theme defines.
export type Appearance<Id extends string = string> = {
  readonly theme: Id
  readonly scheme: Scheme
}

export const themeChangeEvent = "novadeck:themechange"

// Where the boot record lives in localStorage; see docs/theming.md.
export const bootRecordKey = "novadeck.theme-boot"

// The media query that says whether the system uses a dark scheme.
export const darkSchemeQuery = "(prefers-color-scheme: dark)"

const schemePreferences = new Set<string>(["system", "light", "dark"])

const isSchemePreference = (value: unknown): value is SchemePreference =>
  typeof value === "string" && schemePreferences.has(value)

const themeOf = <Id extends string>(manifest: ThemeManifest<Id>, id: string) =>
  manifest.find((entry) => entry.id === id) ?? manifest[0]

// The first theme, following the system's scheme.
export const defaultPreference = <Id extends string>(
  manifest: ThemeManifest<Id>,
): AppearancePreference<Id> => ({ theme: manifest[0].id, scheme: "system" })

// A theme id is lowercase words joined by dashes; the boot script holds the same rule.
const wellFormedId = /^[a-z0-9-]+$/

// A saved preference made safe: a missing or malformed theme becomes the default, and a
// scheme that is not `system`, `light` or `dark` becomes `system`. A well-formed id stays
// even when the app does not know it now, such as an imported theme whose registry loads
// later or one a newer version saved; `resolveAppearance` shows the default for it.
export const appearancePreferenceOf = <Id extends string>(
  value: unknown,
  manifest: ThemeManifest<Id>,
): AppearancePreference => {
  const saved =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const theme =
    typeof saved.theme === "string" && wellFormedId.test(saved.theme) ? saved.theme : manifest[0].id
  return { theme, scheme: isSchemePreference(saved.scheme) ? saved.scheme : "system" }
}

// An unknown theme falls back to the manifest's first. A theme with one scheme always
// uses it; the chosen scheme stays in the preference for the theme that has it. `system`
// follows the system's scheme where the theme has it.
export const resolveAppearance = <Id extends string>(
  preference: AppearancePreference,
  systemDark: boolean,
  manifest: ThemeManifest<Id>,
): Appearance<Id> => {
  const theme = themeOf(manifest, preference.theme)
  const wanted: Scheme =
    preference.scheme === "system" ? (systemDark ? "dark" : "light") : preference.scheme
  const scheme = theme.schemes.includes(wanted) ? wanted : theme.schemes[0]
  return { theme: theme.id, scheme }
}

// The version of the boot record this app writes. Older versions saved the same fields
// for themes since retired, so a record of another version names no theme. The record's
// `ground` is optional, the shown theme's `--color-paper` as `#rrggbb`, so a record
// without it is still of this version.
export const bootRecordVersion = 2

// Reads the theme and scheme from a saved boot record, or nothing when it is missing or
// malformed. Like the boot script, it takes the theme only from a record of this
// version that also holds the theme's schemes; any other record, such as one older
// versions saved, is for the default theme in the saved scheme.
export const parseBootRecord = <Id extends string>(
  text: string | null,
  manifest: ThemeManifest<Id>,
): AppearancePreference | undefined => {
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { v, theme, scheme, schemes } = value as Record<string, unknown>
  if (!isSchemePreference(scheme)) return undefined
  const usable =
    v === bootRecordVersion &&
    typeof theme === "string" &&
    wellFormedId.test(theme) &&
    Array.isArray(schemes) &&
    schemes.length > 0 &&
    schemes.every((entry) => entry === "light" || entry === "dark")
  return { theme: usable ? theme : manifest[0].id, scheme }
}

// Shows an appearance on the page: `data-theme` and `data-scheme` on the root element.
// Changing a theme or scheme already shown stills transitions while it changes, so the
// page changes at once; every change is announced on the window.
export const applyAppearance = (root: HTMLElement, appearance: Appearance): void => {
  // The boot script's color-scheme and ground only stand in until the theme's stylesheet
  // sets them.
  root.style.removeProperty("color-scheme")
  root.style.removeProperty("background-color")
  const { theme, scheme } = root.dataset
  if (theme === appearance.theme && scheme === appearance.scheme) return
  const view = root.ownerDocument.defaultView
  const switching = scheme !== undefined && view !== null
  if (switching) root.dataset.schemeSwitching = ""
  root.dataset.theme = appearance.theme
  root.dataset.scheme = appearance.scheme
  if (switching) {
    // Reading a style makes the browser apply the new scheme now, while transitions are
    // still; left to the next frame, the stilling could come and go before the browser
    // looks, and every control would fade. It ends once a frame has drawn the scheme.
    void view.getComputedStyle(root).color
    view.requestAnimationFrame(() =>
      view.requestAnimationFrame(() => {
        delete root.dataset.schemeSwitching
      }),
    )
  }
  view?.dispatchEvent(new CustomEvent(themeChangeEvent, { detail: appearance }))
}

// The appearance to show at startup, as the boot script resolves it: the boot record's
// choice when one is saved, else the default, against the system's scheme.
export const startingAppearance = <Id extends string>(
  view: Window,
  manifest: ThemeManifest<Id>,
): Appearance<Id> => {
  let saved: string | null = null
  try {
    saved = view.localStorage.getItem(bootRecordKey)
  } catch {
    // Storage can be unavailable; the fallback applies.
  }
  const systemDark = view.matchMedia?.(darkSchemeQuery).matches ?? false
  const preference = parseBootRecord(saved, manifest) ?? defaultPreference(manifest)
  return resolveAppearance(preference, systemDark, manifest)
}
