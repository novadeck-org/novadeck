import type { Backend } from "@novadeck/core/port"

// The browser's stand-in for the desktop app's word on a screen reader: it says `running` at
// once to each page that listens, as the app answers a page's request.
export const createDemoScreenReader =
  (running: boolean): NonNullable<Backend["screenReader"]> =>
  (listener) => {
    listener(running)
    return () => {}
  }
