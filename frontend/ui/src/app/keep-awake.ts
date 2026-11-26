import type { Backend } from "@novadeck/core/port"

import { keepAwakeOn } from "./ui-store"

// What it reads of the UI store.
type KeepAwakeSource = {
  getSnapshot(): Parameters<typeof keepAwakeOn>[0] & { readonly experimentalKnown: boolean }
  subscribe(listener: () => void): () => void
}

/**
 * Tells the app whether the person wants the computer kept awake while agents work, once the
 * page knows whether Experimental is on, and each time that changes, the Experimental switch
 * included. Until then it tells nothing: a window opening or reloading would otherwise let go
 * of the hold every other window keeps, and a page whose channel never answers never does.
 * Where the page can't (a browser) there is nothing to tell. Returns the stop.
 */
export const watchKeepAwake = (
  ui: KeepAwakeSource,
  keepAwake?: Backend["keepAwake"],
): (() => void) => {
  if (!keepAwake) return () => {}
  let told: boolean | undefined
  const tell = (): void => {
    const state = ui.getSnapshot()
    if (!state.experimentalKnown) return
    const on = keepAwakeOn(state)
    if (on === told) return
    told = on
    keepAwake(on)
  }
  tell()
  return ui.subscribe(tell)
}
