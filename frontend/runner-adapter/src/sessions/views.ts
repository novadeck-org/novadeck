import type { RestoredView } from "@novadeck/core/seed"
import type { ViewMode, WindowedView } from "@novadeck/core/types"

import type { SavedSession } from "./state"

// Where the person looks in a session, which is this device's own: the view (Focus, Grid or
// Canvas), the windowed view and the terminal in front. Clients that share a session keep
// these apart, so one's selection never moves another's; this page keeps them, by session,
// in its storage. Saves go on writing them into the shared state too, for builds that read
// them from there, and a device with none of its own reads those.
export type DeviceView = Pick<RestoredView, "view" | "windowedView" | "selected">

/** The fields of a saved state's `state` that are a device's own. */
export const viewKeys = ["view", "windowedView", "selected"] as const

const prefix = "novadeck:session-view:"
const views: ReadonlySet<unknown> = new Set(["focus", "grid", "canvas"])
const windowed: ReadonlySet<unknown> = new Set(["grid", "canvas"])

const storage = (): Storage | undefined => {
  try {
    return globalThis.localStorage
  } catch {
    return undefined
  }
}

const readView = (value: unknown): DeviceView | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const { view, windowedView, selected } = value as Partial<Record<keyof DeviceView, unknown>>
  if (!views.has(view) || !windowed.has(windowedView) || typeof selected !== "string")
    return undefined
  return { view: view as ViewMode, windowedView: windowedView as WindowedView, selected }
}

/** The view a saved state (state.ts) holds, as JSON, if it holds one. */
export const viewOf = (saved: unknown): DeviceView | undefined =>
  typeof saved === "object" && saved !== null
    ? readView((saved as { readonly state?: unknown }).state)
    : undefined

/** This device's view of the session, if it kept one. */
export const deviceView = (sessionId: string): DeviceView | undefined => {
  try {
    const text = storage()?.getItem(prefix + sessionId)
    return text ? readView(JSON.parse(text)) : undefined
  } catch {
    return undefined
  }
}

/** Keeps this device's view of the session, as a save writes it. */
export const keepDeviceView = (sessionId: string, view: DeviceView): void => {
  try {
    storage()?.setItem(
      prefix + sessionId,
      JSON.stringify({ view: view.view, windowedView: view.windowedView, selected: view.selected }),
    )
  } catch {
    // Storage refused, as a private window may: the shared state's view stands in.
  }
}

/** A saved session with this device's own view in place of the shared state's, where it has one. */
export const withDeviceView = (
  sessionId: string,
  saved: SavedSession | undefined,
): SavedSession | undefined => {
  const own = saved && deviceView(sessionId)
  return saved && own ? { state: { ...saved.state, ...own } } : saved
}
