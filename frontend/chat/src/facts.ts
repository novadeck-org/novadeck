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
