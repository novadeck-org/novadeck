import { viewModes } from "@novadeck/core/state"
import { screenReaderPreferences, type PreferencesValue } from "@novadeck/core/types"

import { soundChoiceOf } from "../sounds"
import { appearancePreferenceOf, defaultPreference } from "../theme/apply"
import { themes } from "../theme/themes"
import { fontSizeRange } from "./settings"

export const preferencesStorageKey = "novadeck.preferences"

// A saved size is a whole number in range, as the slider makes; a number out of range or
// between steps (an older or hand-edited file) is brought to the nearest, anything else is
// the default.
export const fontSizeOf = (saved: unknown): number =>
  typeof saved === "number" && Number.isFinite(saved)
    ? Math.min(fontSizeRange.max, Math.max(fontSizeRange.min, Math.round(saved)))
    : fontSizeRange.fallback

export const readPreferences = (): PreferencesValue => {
  const defaults: PreferencesValue = {
    fontSize: fontSizeRange.fallback,
    enabledViews: [...viewModes],
    appearance: defaultPreference(themes),
    notifyNeeds: true,
    notifyFinished: true,
    sound: true,
    soundVolume: 0.6,
    soundChoice: "theme",
    ligatures: false,
    screenReader: "auto",
    chatView: false,
    agentAvatars: false,
    onboardingTour: false,
    foldLongReplies: false,
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
      fontSize: fontSizeOf(saved?.fontSize),
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
      soundChoice: soundChoiceOf(saved?.soundChoice),
      ligatures: typeof saved?.ligatures === "boolean" ? saved.ligatures : defaults.ligatures,
      screenReader:
        screenReaderPreferences.find((choice) => choice === saved?.screenReader) ??
        defaults.screenReader,
      chatView: typeof saved?.chatView === "boolean" ? saved.chatView : defaults.chatView,
      agentAvatars:
        typeof saved?.agentAvatars === "boolean" ? saved.agentAvatars : defaults.agentAvatars,
      onboardingTour:
        typeof saved?.onboardingTour === "boolean" ? saved.onboardingTour : defaults.onboardingTour,
      foldLongReplies:
        typeof saved?.foldLongReplies === "boolean"
          ? saved.foldLongReplies
          : defaults.foldLongReplies,
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
