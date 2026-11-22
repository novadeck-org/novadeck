// The person's own settings, which follow them from device to device: the theme, the views
// they use, Agent Chat, the rail's order, the hints and offers they've seen. Each is text
// under a key, kept on this device (local storage, which the app reads first) and on the
// runner every device shares (`Backend.preferences`), where the last change wins, key by
// key. What stays with the device (text size, panel widths, notifications) never comes here.

import type { PersonPreferences } from "./port"

/** One setting that follows the person. */
export type PersonItem = {
  /** Its name on the runner, as "appearance" or "sidebar-order". */
  readonly key: string
  /** This device's value as text; `undefined` when this device never saved one. */
  readonly read: () => string | undefined
  /** Takes the person's value from another device; `null` when it was forgotten there. */
  readonly write: (text: string | null) => void
}

const items = new Map<string, PersonItem>()
const listeners = new Set<(key: string) => void>()

// The far side, while connected: what it holds, as this device last knew it, and where
// changes go.
let synced:
  | {
      readonly known: Map<string, string>
      readonly preferences: PersonPreferences
    }
  | undefined

// Takes the runner's value of `item`, or gives it this device's where it has none yet: a
// device's settings are never reset by the runner's lacking them.
const reconcile = (item: PersonItem): void => {
  if (!synced) return
  const { known, preferences } = synced
  const kept = known.get(item.key)
  const here = item.read()
  if (kept === undefined) {
    if (here === undefined) return
    known.set(item.key, here)
    preferences.set(item.key, here)
  } else if (here !== kept) item.write(kept)
}

/** Adds a setting that follows the person; returns what removes it. */
export const registerPerson = (item: PersonItem): (() => void) => {
  items.set(item.key, item)
  reconcile(item)
  return () => {
    if (items.get(item.key) === item) items.delete(item.key)
  }
}

/** Tells the runner this device changed the setting `key`, as its item now reads. */
export const savePerson = (key: string): void => {
  const item = items.get(key)
  if (!synced || !item) return
  const text = item.read() ?? null
  if ((synced.known.get(key) ?? null) === text) return
  if (text === null) synced.known.delete(key)
  else synced.known.set(key, text)
  synced.preferences.set(key, text)
}

/** Listens for settings another device changed, by key; returns what stops it. */
export const watchPerson = (listener: (key: string) => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Takes values another device changed.
const take = (values: Readonly<Record<string, string | null>>): void => {
  if (!synced) return
  for (const [key, text] of Object.entries(values)) {
    if (text === null) synced.known.delete(key)
    else synced.known.set(key, text)
    const item = items.get(key)
    // A key this build doesn't know is a newer one's: kept on the runner, untouched here.
    if (!item || (item.read() ?? null) === text) continue
    item.write(text)
    for (const listener of listeners) listener(key)
  }
}

/**
 * Follows the person's settings on the far side: every setting takes the runner's value, or
 * gives it this device's where it has none (the first device after an update gives them; the
 * next takes them), and each change on either side goes to the other. Returns what stops it.
 */
export const syncPerson = (preferences: PersonPreferences): (() => void) => {
  let started = false
  const stop = preferences.subscribe((values, first) => {
    if (!started || first) {
      started = true
      synced = { known: new Map(), preferences }
      for (const [key, text] of Object.entries(values))
        if (text !== null) synced.known.set(key, text)
      for (const item of items.values()) {
        const before = item.read()
        reconcile(item)
        if (item.read() !== before) for (const listener of listeners) listener(item.key)
      }
      return
    }
    take(values)
  })
  return () => {
    stop()
    if (synced?.preferences === preferences) synced = undefined
  }
}

/**
 * A setting kept as text under `local` in this device's local storage, as it always was; the
 * runner's copy of it is `key`. Storage may be unavailable (a private window): it then reads
 * as unsaved, and what another device changes holds for the session.
 */
export const storedPerson = (
  key: string,
  local: string,
): PersonItem & { readonly save: (text: string | null) => void } => {
  let memory: string | null | undefined
  const read = (): string | undefined => {
    try {
      return localStorage.getItem(local) ?? undefined
    } catch {
      return memory ?? undefined
    }
  }
  const put = (text: string | null): void => {
    memory = text
    try {
      if (text === null) localStorage.removeItem(local)
      else localStorage.setItem(local, text)
    } catch {
      /* Kept for this session when storage is unavailable. */
    }
  }
  return {
    key,
    read,
    write: put,
    // This device's own change, which goes to the runner too.
    save: (text) => {
      put(text)
      savePerson(key)
    },
  }
}
