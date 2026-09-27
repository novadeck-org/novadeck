import { createStore, type Store } from "../model/store"

// What the debug panel can ask of the next boot: hold the splash until released, or
// fail the next connection attempt with an error code, once.
export type BootRehearsal = { readonly hold: true } | { readonly fail: string }

// Startup rehearsals for the debug panel. `rehearse` arms one and asks the app for a
// fresh boot through `reboots`; the adapter's connect calls `beforeConnect` first.
export type BootRehearsals = {
  // Changes each time a rehearsal asks for a fresh boot.
  readonly reboots: Store<number>
  readonly rehearse: (rehearsal: BootRehearsal) => void
  // Ends a hold, as Escape does.
  readonly release: () => void
  // Waits out a hold, or rejects with `fail(code)` for an armed failure. An attempt
  // abandoned in the same task, as StrictMode abandons its first, consumes nothing.
  readonly beforeConnect: (signal: AbortSignal, fail: (code: string) => Error) => Promise<void>
}

export const createBootRehearsals = (): BootRehearsals => {
  const reboots = createStore(0)
  let failNext: string | undefined
  let hold: { readonly released: Promise<void>; readonly release: () => void } | undefined
  const release = (): void => {
    hold?.release()
    hold = undefined
  }
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== "Escape" || !hold) return
    window.removeEventListener("keydown", onKey)
    release()
  }
  return {
    reboots,
    rehearse: (rehearsal) => {
      if ("fail" in rehearsal) failNext = rehearsal.fail
      else if (!hold) {
        let resolve: (() => void) | undefined
        const released = new Promise<void>((done) => {
          resolve = done
        })
        hold = { released, release: () => resolve?.() }
        window.addEventListener("keydown", onKey)
      }
      reboots.update((count) => count + 1)
    },
    release: () => {
      window.removeEventListener("keydown", onKey)
      release()
    },
    beforeConnect: async (signal, fail) => {
      // StrictMode abandons its first attempt right away; let it go by untouched.
      await Promise.resolve()
      if (signal.aborted) return
      if (hold) await hold.released
      if (signal.aborted || failNext === undefined) return
      const code = failNext
      failNext = undefined
      throw fail(code)
    },
  }
}
