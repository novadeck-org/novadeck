// The pages of Preferences, in the order its menu lists them; About and Experimental stand at
// the menu's foot.
export const preferencesTabs = [
  { id: "agents", label: "Agents" },
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  { id: "notifications", label: "Notifications" },
  { id: "addons", label: "Addons" },
  { id: "shortcuts", label: "Shortcuts" },
  { id: "about", label: "About" },
  { id: "experimental", label: "Experimental" },
] as const
export type PreferencesTab = (typeof preferencesTabs)[number]["id"]

// The page a URL's section names: a page's own id, or the page that now holds what a former one
// held (General's notifications, bell and transcripts went to Notifications and Terminal; its
// first rows were the notifications); null for a name that was never a page.
export const preferencesTabOf = (name: string): PreferencesTab | null =>
  preferencesTabs.find(({ id }) => id === name)?.id ?? (name === "general" ? "notifications" : null)

// The page Preferences shows where a URL names none Preferences has: Appearance, which every
// backend has, as the Agents page needs agents to list.
export const fallbackTab: PreferencesTab = "appearance"

// Settings sit in cards on the settings ground, one row per setting (settings.css).
export const settingsCardClasses = "card settings-card overflow-hidden"
// Settings each standing on a card of its own, as the welcome dialog draws its choices
// (settings.css); a card above holds settings that belong together.
export const settingsStackClasses = "settings-stack m-0 flex flex-col gap-2 p-0"
export const settingRowClasses =
  "settings-row flex min-h-13 items-center justify-between gap-6 px-4 py-3 text-body"

// The terminal text sizes Preferences offers, in CSS pixels, one step apart.
export const fontSizeRange = { min: 10, max: 32, fallback: 13 } as const

// What Preferences shows of the app's version: local and pull request builds carry 0.0.0,
// which names no release.
export const versionText = (version: string): string =>
  version === "0.0.0" ? "Development build" : version
