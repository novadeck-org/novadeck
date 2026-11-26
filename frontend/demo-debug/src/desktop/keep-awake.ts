import type { Backend } from "@novadeck/core/port"

// The preview page's stand-in for the desktop app's keeping the computer awake, so the
// Preferences' Keep awake rows show and work there: what the app would be told is marked on
// the page's root, as `data-keep-awake`, for a look in the inspector.
export const demoKeepAwake: NonNullable<Backend["keepAwake"]> = (on) => {
  document.documentElement.dataset.keepAwake = String(on)
}
