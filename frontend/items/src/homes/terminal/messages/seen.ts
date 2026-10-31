import { createStore, type MutableStore } from "@novadeck/core/store"

// When the person last opened each conversation, so an agent's thread can say it has news:
// the UI's alone, as the runner keeps no seen-by-the-person state for agents' messages. It
// lives in local storage, which every window shares. What the pane first sees counts as
// read up to then (`since`): opening the app says what happened since, not a backlog. A
// conversation is named by its terminal's key and its own (`seenKey`).

export const seenStorageKey = "novadeck.messages-seen"

// Past this many conversations, the ones opened longest ago are forgotten, back to `since`.
const kept = 2000

export type Seen = {
  readonly since: number
  readonly at: Readonly<Record<string, number>>
}

export const seenKey = (terminal: string, conversation: string): string =>
  `${terminal}/${conversation}`

export const readSeen = (now: number): Seen => {
  try {
    const stored = JSON.parse(localStorage.getItem(seenStorageKey) ?? "null") as {
      since?: unknown
      at?: unknown
    } | null
    if (typeof stored?.since === "number" && stored.at && typeof stored.at === "object")
      return {
        since: stored.since,
        at: Object.fromEntries(
          Object.entries(stored.at).filter(
            (entry): entry is [string, number] => typeof entry[1] === "number",
          ),
        ),
      }
  } catch {
    /* Read as a first launch. */
  }
  const first = { since: now, at: {} }
  writeSeen(first)
  return first
}

const writeSeen = (seen: Seen): void => {
  try {
    localStorage.setItem(seenStorageKey, JSON.stringify(seen))
  } catch {
    /* Remembered for this session when storage is unavailable. */
  }
}

// When the person last saw a conversation.
export const seenAt = (seen: Seen, key: string): number => seen.at[key] ?? seen.since

// The person saw a conversation up to `at`; never back.
export const markSeen = (seen: Seen, key: string, at: number): Seen => {
  if (at <= seenAt(seen, key)) return seen
  const entries = Object.entries({ ...seen.at, [key]: at })
  return {
    since: seen.since,
    at: Object.fromEntries(
      entries.length > kept ? entries.toSorted((a, b) => b[1] - a[1]).slice(0, kept) : entries,
    ),
  }
}

let shared: MutableStore<Seen> | null = null

// The app's one record, read once, written as it changes, and read again as another window
// writes it.
export const seenStore = (): MutableStore<Seen> => {
  if (shared) return shared
  const store = createStore(readSeen(Date.now()))
  store.subscribe(() => writeSeen(store.getSnapshot()))
  window.addEventListener("storage", (event) => {
    if (event.key === seenStorageKey && event.newValue !== null)
      store.update(() => readSeen(Date.now()))
  })
  shared = store
  return store
}
