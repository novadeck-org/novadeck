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

// A saved font family is a name as the computer lists it: text of a sensible length with no
// control characters. Anything else is the bundled font, "". A family that is no longer
// installed stays saved, so it returns when the font does.
export const fontFamilyOf = (saved: unknown): string => {
  if (typeof saved !== "string") return ""
  const name = saved.trim()
  // oxlint-disable-next-line no-control-regex -- Control characters are what this refuses.
  return name.length <= 200 && !/[\u0000-\u001f\u007f-\u009f]/.test(name) ? name : ""
}

export const readPreferences = (): PreferencesValue => {
  const defaults: PreferencesValue = {
    fontSize: fontSizeRange.fallback,
    fontFamily: "",
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
      fontFamily: fontFamilyOf(saved?.fontFamily),
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
