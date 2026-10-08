import type { Backend, WindowAppearance } from "../backend/port"
import type { Store } from "../model/store"
import type { PreferencesValue } from "../model/types"
import { preferencesStorageKey, readPreferences } from "../preferences/preferences-storage"
import {
  applyAppearance,
  bootRecordKey,
  bootRecordVersion,
  darkSchemeQuery,
  resolveAppearance,
} from "../theme/apply"
import { hexColor, tokenColors } from "../theme/probe"
import { themes } from "../theme/themes"
import type { UiState } from "./ui-store"

// The scheme the window's native parts use: the system's while the page follows it, so
// the page's `prefers-color-scheme` keeps reporting the system's own. A theme with one
// scheme never follows the system, so the window takes the scheme the page shows.
const windowScheme = (
  preference: PreferencesValue["appearance"],
  shown: WindowAppearance["scheme"],
): WindowAppearance["scheme"] => {
  const theme = themes.find((entry) => entry.id === preference.theme) ?? themes[0]
  return preference.scheme === "system" && theme.schemes.length > 1 ? "system" : shown
}

// How long a window released from a pinned scheme waits for the system's own to arrive,
// for when it is the pinned one and nothing changes.
export const releaseMs = 200

// Shows the preferred appearance on the page and keeps it there: again whenever the
// preference changes and, while it follows the system, whenever the system's scheme
// does. Each time it saves what the boot script needs, the theme's schemes among it, and
// tells the window around the page, where there is one. Returns the stop.
export const watchAppearance = (
  ui: Store<UiState>,
  view: Window,
  showAppearance?: Backend["showAppearance"],
): (() => void) => {
  const root = view.document.documentElement
  const system = view.matchMedia?.(darkSchemeQuery)
  let saved: string | undefined
  let shown: string | undefined
  // Whether the window's native parts are pinned to a scheme, which then is all the
  // page's `prefers-color-scheme` reports, not the system's.
  let pinned = false
  let releasing: ReturnType<typeof setTimeout> | undefined
  // The ground the page paints first: the body's, before the workspace draws on it.
  const groundOf = (): string | undefined =>
    tokenColors(view.document.body, ["--color-paper"])["--color-paper"]?.slice(0, 7)
  // What the page paints before anything else: <html>'s ground when the theme gives it an
  // opaque one, as Phosphor's black tube, else the body's paper.
  const firstGroundOf = (): string | undefined => {
    const own = hexColor(view.document, view.getComputedStyle(root).backgroundColor)
    return own && (own.length === 7 || own.endsWith("ff")) ? own.slice(0, 7) : groundOf()
  }
  const apply = (): void => {
    clearTimeout(releasing)
    releasing = undefined
    const preference = ui.getSnapshot().preferences.appearance
    // A pinned window going back to the system is released first, and the page shows the
    // system's scheme once the query reports it: as it changes, or after a moment when the
    // system's scheme was the pinned one. Until then the page keeps what it shows, rather
    // than painting the pin's scheme and then the system's.
    if (pinned && showAppearance && windowScheme(preference, "dark") === "system") {
      const ground = groundOf()
      if (ground) {
        pinned = false
        shown = undefined
        showAppearance({ scheme: "system", ground })
        releasing = setTimeout(apply, releaseMs)
        return
      }
    }
    const appearance = resolveAppearance(preference, system?.matches ?? false, themes)
    applyAppearance(root, appearance)
    // The ground goes in the record so the next start paints it before any stylesheet,
    // even for a theme the boot CSS does not know: what the page paints first, <html>'s
    // own ground where the theme sets one, else the paper. It holds for the scheme shown
    // now, which the record names, so a start in another scheme skips it.
    const ground = firstGroundOf()
    const record = JSON.stringify({
      v: bootRecordVersion,
      theme: appearance.theme,
      scheme: preference.scheme,
      schemes: themes.find((entry) => entry.id === appearance.theme)?.schemes,
      ...(ground ? { ground, groundScheme: appearance.scheme } : {}),
    })
    if (record !== saved) {
      saved = record
      try {
        view.localStorage.setItem(bootRecordKey, record)
      } catch {
        // Without storage the next start shows the default until the app applies this.
      }
    }
    if (!showAppearance) return
    const painted = groundOf()
    if (!painted) return
    const look: WindowAppearance = {
      scheme: windowScheme(preference, appearance.scheme),
      ground: painted,
    }
    pinned = look.scheme !== "system"
    const report = JSON.stringify(look)
    if (report === shown) return
    shown = report
    showAppearance(look)
  }
  apply()
  let preference = ui.getSnapshot().preferences.appearance
  const stop = ui.subscribe(() => {
    const next = ui.getSnapshot().preferences.appearance
    if (next === preference) return
    preference = next
    apply()
  })
  system?.addEventListener("change", apply)
  return () => {
    stop()
    clearTimeout(releasing)
    system?.removeEventListener("change", apply)
  }
}

// Takes up preferences another window saved, so every window shows the same theme and
// settings. Returns the stop.
export const followSavedPreferences = (
  ui: Store<UiState>,
  view: Window,
  update: (next: PreferencesValue) => void,
): (() => void) => {
  const follow = (event: StorageEvent): void => {
    if (event.key !== preferencesStorageKey && event.key !== null) return
    const next = readPreferences()
    if (JSON.stringify(next) === JSON.stringify(ui.getSnapshot().preferences)) return
    update(next)
  }
  view.addEventListener("storage", follow)
  return () => view.removeEventListener("storage", follow)
}
