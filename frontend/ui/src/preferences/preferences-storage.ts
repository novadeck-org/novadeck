import { viewModes } from "@novadeck/core/state"
import { appScales, screenReaderPreferences, type PreferencesValue } from "@novadeck/core/types"

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

// The preferences that follow the person from device to device (core's person.ts), by their
// names on the runner. The rest are this device's: its text, its scale, its sounds and
// notifications, its screen reader, its windows.
export const personPreferences = {
  appearance: "appearance",
  enabledViews: "enabled-views",
  chatView: "chat-view",
  agentAvatars: "agent-avatars",
  onboardingTour: "onboarding-tour",
} as const satisfies Partial<Record<keyof PreferencesValue, string>>

// Saved preferences as the app takes them: each it can read, the default for the rest.
export const preferencesFrom = (
  saved: Partial<PreferencesValue> | null | undefined,
): PreferencesValue => {
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
    projectWindows: false,
    onboardingTour: false,
    appScale: 100,
  }
  if (typeof saved !== "object" || saved === null) return defaults
  const enabledViews = Array.isArray(saved?.enabledViews)
    ? viewModes.filter((mode) => saved.enabledViews!.includes(mode))
    : defaults.enabledViews
  return {
    enabledViews: enabledViews.length ? enabledViews : defaults.enabledViews,
    fontSize: fontSizeOf(saved?.fontSize),
    fontFamily: fontFamilyOf(saved?.fontFamily),
    appearance: appearancePreferenceOf(saved?.appearance, themes),
    notifyNeeds: typeof saved?.notifyNeeds === "boolean" ? saved.notifyNeeds : defaults.notifyNeeds,
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
    projectWindows:
      typeof saved?.projectWindows === "boolean" ? saved.projectWindows : defaults.projectWindows,
    onboardingTour:
      typeof saved?.onboardingTour === "boolean" ? saved.onboardingTour : defaults.onboardingTour,
    // A saved scale the app doesn't offer is the normal one.
    appScale: appScales.find((scale) => scale === saved?.appScale) ?? defaults.appScale,
  }
}

export const readPreferences = (): PreferencesValue => {
  try {
    return preferencesFrom(
      JSON.parse(
        localStorage.getItem(preferencesStorageKey) ?? "null",
      ) as Partial<PreferencesValue> | null,
    )
  } catch {
    return preferencesFrom(null)
  }
}

export const writePreferences = (preferences: PreferencesValue): void => {
  try {
    localStorage.setItem(preferencesStorageKey, JSON.stringify(preferences))
  } catch {
    /* Preferences still apply when storage is unavailable. */
  }
}
