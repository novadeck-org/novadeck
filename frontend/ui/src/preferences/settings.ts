// The sections of Preferences, in the order its tabs show them.
export const preferencesTabs = [
  { id: "general", label: "General" },
  { id: "appearance", label: "Appearance" },
  { id: "addons", label: "Addons" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
  { id: "experimental", label: "Experimental" },
] as const
export type PreferencesTab = (typeof preferencesTabs)[number]["id"]

// Settings sit in cards on the settings ground, one row per setting (settings.css).
export const settingsCardClasses = "card settings-card overflow-hidden"
export const settingRowClasses =
  "settings-row flex min-h-13 items-center justify-between gap-6 px-4 py-3 text-body"

// What Preferences shows of the app's version: local and pull request builds carry 0.0.0,
// which names no release.
export const versionText = (version: string): string =>
  version === "0.0.0" ? "Development build" : version
