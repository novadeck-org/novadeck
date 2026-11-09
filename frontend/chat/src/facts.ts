import { useSyncExternalStore } from "react"

// The facts at a row's right edge: a time of day, a span, how long ago. All from the record's
// own times (`at`, epoch milliseconds), which a harness may not give: where there is none, there is
// no fact.

// Work that took less than this stays bare.
export const longMs = 5000

const pad = (value: number): string => String(value).padStart(2, "0")

// "38s", "1m 05s", "1h 05m": how long, to the second under an hour.
export const span = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${pad(seconds % 60)}s`
  return `${Math.floor(minutes / 60)}h ${pad(minutes % 60)}m`
}

// "14:07", in the person's own format for the time of day.
export const timeOfDay = (at: number): string =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })

// Whole seconds of now, one clock for every running fact on the page: it ticks only while one
// shows.
const listeners = new Set<() => void>()
let timer: ReturnType<typeof setInterval> | undefined
let now = Date.now()
const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  if (timer === undefined) {
    now = Date.now()
    timer = setInterval(() => {
      now = Date.now()
      for (const each of listeners) each()
    }, 1000)
  }
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
    }
  }
}
export const useNow = (): number => useSyncExternalStore(subscribe, () => now)

// When the chat first saw each request, which asked how long ago has no record of: the protocol
// carries no time for a request, so the wait counts from here, and a chat opened after the request
// came undercounts it.
const seen = new Map<string, number>()
const seenMax = 200
export const askedAt = (id: string): number => {
  const known = seen.get(id)
  if (known !== undefined) return known
  const at = Date.now()
  seen.set(id, at)
  if (seen.size > seenMax) seen.delete(seen.keys().next().value!)
  return at
}
