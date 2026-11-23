import type { RestoredView } from "@novadeck/core/seed"
import type { ViewMode, WindowedView } from "@novadeck/core/types"
import { desktopApp, windowKeyOf } from "@novadeck/protocol/bridge"

import type { SavedSession } from "./state"

// Where the person looks in a session, which is this device's own: the view (Focus, Grid or
// Canvas), the windowed view and the terminal in front. Clients that share a session keep
// these apart, so one's selection never moves another's; this page keeps them, by session,
// in its storage. Saves go on writing them into the shared state too, for builds that read
// them from there, and a device with none of its own reads those.
//
// A desktop window has a key (see `DesktopApp.windowKey`), and two windows may show one
// session, so each keeps its own view under its key as well, which it reads first; the device's
// is the one used last, where a new window starts from. Without a key (a browser) only the
// device's is kept.
export type DeviceView = Pick<RestoredView, "view" | "windowedView" | "selected">

/** The fields of a saved state's `state` that are a device's own. */
export const viewKeys = ["view", "windowedView", "selected"] as const

const prefix = "novadeck:session-view:"
const windowSessionPrefix = "novadeck:window-session:"
const views: ReadonlySet<unknown> = new Set(["focus", "grid", "canvas"])
const windowed: ReadonlySet<unknown> = new Set(["grid", "canvas"])

/** This window's key, where the desktop app gave it one. */
const windowKey = (): string | undefined => windowKeyOf(desktopApp()?.windowKey)

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

const readStored = (key: string): DeviceView | undefined => {
  try {
    const text = storage()?.getItem(key)
    return text ? readView(JSON.parse(text)) : undefined
  } catch {
    return undefined
  }
}

/** This window's view of the session if it kept one, else this device's. */
export const deviceView = (sessionId: string): DeviceView | undefined => {
  const key = windowKey()
  return (key && readStored(`${prefix}${key}:${sessionId}`)) || readStored(prefix + sessionId)
}

/** Keeps this window's view of the session, and the device's, as a save writes it. */
export const keepDeviceView = (sessionId: string, view: DeviceView): void => {
  const text = JSON.stringify({
    view: view.view,
    windowedView: view.windowedView,
    selected: view.selected,
  })
  const key = windowKey()
  for (const name of key
    ? [`${prefix}${key}:${sessionId}`, prefix + sessionId]
    : [prefix + sessionId]) {
    try {
      storage()?.setItem(name, text)
    } catch {
      // Storage refused, as a private window may: the shared state's view stands in.
    }
  }
}

/** The session this window showed last in the project, if it has a key and kept one. */
export const windowSession = (projectId: string): string | undefined => {
  const key = windowKey()
  try {
    return (key && storage()?.getItem(`${windowSessionPrefix}${key}:${projectId}`)) || undefined
  } catch {
    return undefined
  }
}

/** Keeps the session this window shows in the project; nothing without a window key. */
export const keepWindowSession = (projectId: string, sessionId: string): void => {
  const key = windowKey()
  if (!key) return
  try {
    storage()?.setItem(`${windowSessionPrefix}${key}:${projectId}`, sessionId)
  } catch {
    // Storage refused: the project opens on the session visited last.
  }
}

// What a window kept under its key: `<prefix><key>:<id>`.
const keptByWindow = /^novadeck:(?:session-view|window-session):([0-9a-f-]{36}):/i

/**
 * Clears what windows that are gone for good kept under their keys, which nothing reads again:
 * every keyed view and session but those of `live`, the windows the app keeps or has open, and
 * this window's own. The device's own views stay.
 */
export const forgetClosedWindows = (live: readonly string[]): void => {
  const keep = new Set([...live, windowKey()].filter((key) => key !== undefined))
  try {
    const store = storage()
    if (!store) return
    const names = Array.from({ length: store.length }, (_, index) => store.key(index))
    for (const name of names) {
      const key = name ? windowKeyOf(keptByWindow.exec(name)?.[1]) : undefined
      if (name && key && !keep.has(key)) store.removeItem(name)
    }
  } catch {
    // Storage refused: what is kept stays, as before.
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
