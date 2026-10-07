import type { Scheme, SchemePreference } from "./scheme"

// What the person chose.
export type AppearancePreference = { readonly scheme: SchemePreference }

// What the page shows.
export type Appearance = { readonly scheme: Scheme }

export const themeChangeEvent = "novadeck:themechange"

// Where the boot record lives in localStorage; see docs/theming.md.
export const bootRecordKey = "novadeck.theme-boot"

// The media query that says whether the system uses a dark scheme.
export const darkSchemeQuery = "(prefers-color-scheme: dark)"

const schemePreferences = new Set<string>(["system", "light", "dark"])

const isSchemePreference = (value: unknown): value is SchemePreference =>
  typeof value === "string" && schemePreferences.has(value)

// Following the system's scheme.
export const defaultPreference: AppearancePreference = { scheme: "system" }

// A saved preference made safe: a scheme that is not `system`, `light` or `dark` becomes
// `system`. Other keys, such as the theme older versions saved, are ignored.
export const appearancePreferenceOf = (value: unknown): AppearancePreference => {
  const saved =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  return { scheme: isSchemePreference(saved.scheme) ? saved.scheme : "system" }
}

// `system` follows the system's scheme; a named scheme is shown as it is.
export const resolveAppearance = (
  preference: AppearancePreference,
  systemDark: boolean,
): Appearance => ({
  scheme: preference.scheme === "system" ? (systemDark ? "dark" : "light") : preference.scheme,
})

// Reads the chosen scheme from a saved boot record, or nothing when it is missing or
// malformed. Records older versions saved also hold a theme and its schemes, which are
// ignored.
export const parseBootRecord = (text: string | null): AppearancePreference | undefined => {
  if (!text) return undefined
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const { scheme } = value as Record<string, unknown>
  return isSchemePreference(scheme) ? { scheme } : undefined
}

// Shows an appearance on the page: `data-scheme` on the root element. Changing a scheme
// already shown stills transitions while it changes, so the page changes at once; every
// change is announced on the window.
export const applyAppearance = (root: HTMLElement, appearance: Appearance): void => {
  // The boot script's color-scheme only stands in until the theme's stylesheet sets it.
  root.style.removeProperty("color-scheme")
  const { scheme } = root.dataset
  if (scheme === appearance.scheme) return
  const view = root.ownerDocument.defaultView
  const switching = scheme !== undefined && view !== null
  if (switching) root.dataset.schemeSwitching = ""
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
export const startingAppearance = (view: Window): Appearance => {
  let saved: string | null = null
  try {
    saved = view.localStorage.getItem(bootRecordKey)
  } catch {
    // Storage can be unavailable; the fallback applies.
  }
  const systemDark = view.matchMedia?.(darkSchemeQuery).matches ?? false
  return resolveAppearance(parseBootRecord(saved) ?? defaultPreference, systemDark)
}
