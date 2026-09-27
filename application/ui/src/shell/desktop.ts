import { useSyncExternalStore } from "react"

const desktopQuery = "(min-width: 701px)"

const subscribe = (notify: () => void): (() => void) => {
  const media = window.matchMedia(desktopQuery)
  media.addEventListener("change", notify)
  return () => media.removeEventListener("change", notify)
}

// Wide enough for the resizable sidebar instead of the phone drawer.
export const isDesktop = (): boolean => window.matchMedia(desktopQuery).matches
export const useDesktop = (): boolean => useSyncExternalStore(subscribe, isDesktop)
