import type { DemoStates } from "./types"

// The browser's stand-in for the desktop app's self-updates: `offer` has a version
// downloaded, which listeners hear at once if they come later and again for each newer
// one. `install` does nothing more, so the footer's Restarting… stays for as long as
// anyone wants to look at it; `finish` ends the restart as the app comes back, a reload
// that forgets the offer, while one waits.
export const createDemoUpdates = (
  restart: () => void = () => window.location.reload(),
): {
  readonly updates: DemoStates["updates"]
  readonly offer: (version: string) => void
  readonly finish: () => void
} => {
  let waiting: string | undefined
  const listeners = new Set<(version: string) => void>()
  return {
    updates: {
      onReady: (listener) => {
        listeners.add(listener)
        if (waiting !== undefined) listener(waiting)
        return () => void listeners.delete(listener)
      },
      install: () => {},
    },
    offer: (version) => {
      waiting = version
      listeners.forEach((listener) => listener(version))
    },
    finish: () => {
      if (waiting !== undefined) restart()
    },
  }
}
