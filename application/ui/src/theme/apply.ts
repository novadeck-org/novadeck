import type { Scheme, SchemePreference, ThemeManifest } from "./themes"

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

// What `public/theme-boot.js` needs to show the theme before the first paint: a theme
// the manifest has, the chosen scheme, and the schemes that theme defines.
export type BootRecord = AppearancePreference & { readonly schemes: readonly Scheme[] }

const schemePreferences = new Set<string>(["system", "light", "dark"])

const isSchemePreference = (value: unknown): value is SchemePreference =>
  typeof value === "string" && schemePreferences.has(value)

const themeOf = <Id extends string>(manifest: ThemeManifest<Id>, id: string) =>
  manifest.find((entry) => entry.id === id) ?? manifest[0]

// The first theme, following the system's scheme.
export const defaultPreference = <Id extends string>(
  manifest: ThemeManifest<Id>,
): AppearancePreference<Id> => ({ theme: manifest[0].id, scheme: "system" })

// A saved preference made safe: an unknown theme becomes the default, and a scheme
// that is not `system`, `light` or `dark` becomes `system`.
export const appearancePreferenceOf = <Id extends string>(
  value: unknown,
  manifest: ThemeManifest<Id>,
): AppearancePreference<Id> => {
  const saved =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const theme = typeof saved.theme === "string" ? themeOf(manifest, saved.theme).id : manifest[0].id
  return { theme, scheme: isSchemePreference(saved.scheme) ? saved.scheme : "system" }
}

// The record the boot script reads for a preference.
export const bootRecordOf = (
  preference: AppearancePreference,
  manifest: ThemeManifest,
): BootRecord => {
  const theme = themeOf(manifest, preference.theme)
  return { theme: theme.id, scheme: preference.scheme, schemes: theme.schemes }
}

// An unknown theme falls back to the manifest's first; a theme with one scheme always
// uses it, and `system` follows the system's scheme where the theme has it.
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

// Reads the theme and scheme from a saved boot record, or nothing when it is missing
// or malformed.
export const parseBootRecord = (text: string | null): AppearancePreference | undefined => {
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { theme, scheme } = value as Record<string, unknown>
  if (typeof theme !== "string" || !isSchemePreference(scheme)) return undefined
  return { theme, scheme }
}

// Shows an appearance on the page: `data-theme` and `data-scheme` on the root element.
// Changing a theme already shown stills transitions while it changes, so the page
// changes at once; every change is announced on the window.
export const applyAppearance = (root: HTMLElement, appearance: Appearance): void => {
  // The boot script's color-scheme only stands in until the theme's stylesheet sets it.
  root.style.removeProperty("color-scheme")
  const { theme, scheme } = root.dataset
  if (theme === appearance.theme && scheme === appearance.scheme) return
  const view = root.ownerDocument.defaultView
  const switching = theme !== undefined && view !== null
  if (switching) root.dataset.themeSwitching = ""
  root.dataset.theme = appearance.theme
  root.dataset.scheme = appearance.scheme
  if (switching) {
    // Reading a style makes the browser apply the new theme now, while transitions are
    // still; left to the next frame, the stilling could come and go before the browser
    // looks, and every control would fade. It ends once a frame has drawn the theme.
    void view.getComputedStyle(root).color
    view.requestAnimationFrame(() =>
      view.requestAnimationFrame(() => {
        delete root.dataset.themeSwitching
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
  const preference = parseBootRecord(saved) ?? defaultPreference(manifest)
  return resolveAppearance(preference, systemDark, manifest)
}
