import type { Backend } from "@novadeck/core/port"

// The preview page's stand-in for the desktop app's scaling of its windows, so the
// Preferences' Scale row shows and works there: the page's root is zoomed by CSS, as the app
// zooms its window.
export const demoShowScale: NonNullable<Backend["showScale"]> = (scale) => {
  document.documentElement.style.setProperty("zoom", String(scale))
}
