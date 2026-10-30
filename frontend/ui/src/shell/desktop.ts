import { useSyncExternalStore } from "react"

// "Desktop" is the wide viewport, as the grid's `desktop` breakpoint is, against a phone's;
// not the desktop app, which a browser window can be as wide as.
const desktopQuery = "(min-width: 701px)"

export const subscribeDesktop = (notify: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}

// Wide enough for the resizable sidebar instead of the phone drawer.
export const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches
export const useDesktop = (): boolean => useSyncExternalStore(subscribeDesktop, isDesktop)
