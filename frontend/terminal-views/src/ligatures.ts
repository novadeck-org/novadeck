import { rootSetting } from "./root-setting"

// The Ligatures setting: `data-ligatures` on the page's root, set from Preferences.

export const ligaturesOn = (): boolean => document.documentElement.dataset.ligatures === "on"

// Tells `changed` when the setting changes, until the returned stop.
export const watchLigatures = rootSetting("data-ligatures")
