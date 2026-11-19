import type { Backend } from "@novadeck/core/port"

// The browser's stand-in for the desktop app's word on a screen reader: it says whether one
// runs at once to each page that listens, as the app answers a page's request, and tells them
// when `set` changes it, as the app does when one starts or stops.
export const createDemoScreenReader = (
  running: boolean,
): {
  readonly screenReader: NonNullable<Backend["screenReader"]>
  readonly set: (running: boolean) => void
} => {
  let now = running
  const listeners = new Set<(running: boolean) => void>()
  return {
    screenReader: (listener) => {
      listeners.add(listener)
      listener(now)
      return () => listeners.delete(listener)
    },
    set: (next) => {
      now = next
      listeners.forEach((listener) => listener(next))
    },
  }
}
