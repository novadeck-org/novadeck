import type { Backend } from "@novadeck/core/port"

import { keepAwakeOn } from "./ui-store"

// What it reads of the UI store.
type KeepAwakeSource = {
  getSnapshot(): Parameters<typeof keepAwakeOn>[0]
  subscribe(listener: () => void): () => void
}

/**
 * Tells the app whether the person wants the computer kept awake while agents work, as the
 * page starts and each time that changes, the Experimental switch included. Where the page
 * can't (a browser) there is nothing to tell. Returns the stop.
 */
export const watchKeepAwake = (
  ui: KeepAwakeSource,
  keepAwake?: Backend["keepAwake"],
): (() => void) => {
  if (!keepAwake) return () => {}
  let told: boolean | undefined
  const tell = (): void => {
    const on = keepAwakeOn(ui.getSnapshot())
    if (on === told) return
    told = on
    keepAwake(on)
  }
  tell()
  return ui.subscribe(tell)
}
