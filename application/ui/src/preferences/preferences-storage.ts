import { viewModes } from "../model/state"
import type { PreferencesValue } from "../model/types"
import { appearancePreferenceOf, defaultPreference } from "../theme/apply"

export const preferencesStorageKey = "novadeck.preferences"

export const readPreferences = (): PreferencesValue => {
  const defaults: PreferencesValue = {
    fontSize: 13,
    enabledViews: [...viewModes],
    appearance: defaultPreference,
    notifyFinished: true,
    ligatures: false,
  }
  try {
    const saved = JSON.parse(
      localStorage.getItem(preferencesStorageKey) ?? "null",
    ) as Partial<PreferencesValue> | null
    const enabledViews = Array.isArray(saved?.enabledViews)
      ? viewModes.filter((mode) => saved.enabledViews!.includes(mode))
      : defaults.enabledViews
    return {
      enabledViews: enabledViews.length ? enabledViews : defaults.enabledViews,
      fontSize: [12, 13, 15].includes(saved?.fontSize ?? 0) ? saved!.fontSize! : defaults.fontSize,
      appearance: appearancePreferenceOf(saved?.appearance),
      notifyFinished:
        typeof saved?.notifyFinished === "boolean" ? saved.notifyFinished : defaults.notifyFinished,
      ligatures: typeof saved?.ligatures === "boolean" ? saved.ligatures : defaults.ligatures,
    }
  } catch {
    return defaults
  }
}

export const writePreferences = (preferences: PreferencesValue): void => {
  try {
    localStorage.setItem(preferencesStorageKey, JSON.stringify(preferences))
  } catch {
    /* Preferences still apply when storage is unavailable. */
  }
}
