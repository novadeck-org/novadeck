import { viewModes } from "@novadeck/core/state"
import type { PreferencesValue } from "@novadeck/core/types"

import { appearancePreferenceOf, defaultPreference } from "../theme/apply"
import { themes } from "../theme/themes"

export const preferencesStorageKey = "novadeck.preferences"

export const readPreferences = (): PreferencesValue => {
  const defaults: PreferencesValue = {
    fontSize: 13,
    enabledViews: [...viewModes],
    appearance: defaultPreference(themes),
    notifyNeeds: true,
    notifyFinished: true,
    sound: true,
    soundVolume: 0.6,
    ligatures: false,
    chatView: false,
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
      appearance: appearancePreferenceOf(saved?.appearance, themes),
      notifyNeeds:
        typeof saved?.notifyNeeds === "boolean" ? saved.notifyNeeds : defaults.notifyNeeds,
      notifyFinished:
        typeof saved?.notifyFinished === "boolean" ? saved.notifyFinished : defaults.notifyFinished,
      sound: typeof saved?.sound === "boolean" ? saved.sound : defaults.sound,
      soundVolume:
        typeof saved?.soundVolume === "number" && Number.isFinite(saved.soundVolume)
          ? Math.min(1, Math.max(0, saved.soundVolume))
          : defaults.soundVolume,
      ligatures: typeof saved?.ligatures === "boolean" ? saved.ligatures : defaults.ligatures,
      chatView: typeof saved?.chatView === "boolean" ? saved.chatView : defaults.chatView,
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
