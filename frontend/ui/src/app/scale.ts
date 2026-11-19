import type { Backend } from "@novadeck/core/port"
import type { PreferencesValue } from "@novadeck/core/types"

// What it reads of the UI store.
type ScaleSource = {
  getSnapshot(): { readonly preferences: Pick<PreferencesValue, "appScale"> }
  subscribe(listener: () => void): () => void
}

/**
 * Tells the window around the page the scale the person chose, as the page starts and each
 * time they change it, so every window of the app shows it. Where nothing surrounds the page
 * (a browser, whose own zoom does it) there is nothing to tell. Returns the stop.
 */
export const watchScale = (ui: ScaleSource, showScale?: Backend["showScale"]): (() => void) => {
  if (!showScale) return () => {}
  let shown: number | undefined
  const show = (): void => {
    const scale = ui.getSnapshot().preferences.appScale
    if (scale === shown) return
    shown = scale
    showScale(scale / 100)
  }
  show()
  return ui.subscribe(show)
}
