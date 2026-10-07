import type { Backend, WindowAppearance } from "../backend/port"
import type { Store } from "../model/store"
import type { PreferencesValue } from "../model/types"
import { preferencesStorageKey, readPreferences } from "../preferences/preferences-storage"
import { applyAppearance, bootRecordKey, darkSchemeQuery, resolveAppearance } from "../theme/apply"
import { tokenColors } from "../theme/probe"
import type { UiState } from "./ui-store"

// The scheme the window's native parts use: the system's while the page follows it, so
// the page's `prefers-color-scheme` keeps reporting the system's own.
const windowScheme = (
  preference: PreferencesValue["appearance"],
  shown: WindowAppearance["scheme"],
): WindowAppearance["scheme"] => {
  return preference.scheme === "system" ? "system" : shown
}

// Shows the preferred appearance on the page and keeps it there: again whenever the
// preference changes and, while it follows the system, whenever the system's scheme
// does. Each time it saves what the boot script needs and tells the window around the
// page, where there is one. Returns the stop.
export const watchAppearance = (
  ui: Store<UiState>,
  view: Window,
  showAppearance?: Backend["showAppearance"],
): (() => void) => {
  const root = view.document.documentElement
  const system = view.matchMedia?.(darkSchemeQuery)
  let saved: string | undefined
  let shown: string | undefined
  const apply = (): void => {
    const preference = ui.getSnapshot().preferences.appearance
    const appearance = resolveAppearance(preference, system?.matches ?? false)
    applyAppearance(root, appearance)
    const record = JSON.stringify({ scheme: preference.scheme })
    if (record !== saved) {
      saved = record
      try {
        view.localStorage.setItem(bootRecordKey, record)
      } catch {
        // Without storage the next start shows the default until the app applies this.
      }
    }
    if (!showAppearance) return
    // The ground the page paints first: the body's, before the workspace draws on it.
    const ground = tokenColors(view.document.body, ["--color-paper"])["--color-paper"]
    if (!ground) return
    const look: WindowAppearance = {
      scheme: windowScheme(preference, appearance.scheme),
      ground: ground.slice(0, 7),
    }
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
    system?.removeEventListener("change", apply)
  }
}

// Takes up preferences another window saved, so every window shows the same scheme and
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
