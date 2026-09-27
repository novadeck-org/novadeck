import { createStore, type Store } from "../../model/store"
import type { BootProgress, TerminalKey } from "../port"

// What boot progress needs to know of a terminal.
export type BootEntry = {
  // Settles once the runner has its shell, or could not start it. Replaced whenever a
  // fresh shell starts.
  readonly ready: Promise<unknown>
  readonly closed: boolean
  // Exited or failed: nothing more is coming for it.
  readonly settled: boolean
}

export type BootProgressTracker = {
  readonly store: Store<BootProgress>
  // Starts counting the terminals on screen; later calls do nothing.
  readonly begin: (ids: readonly string[]) => void
  // Looks again, as after a terminal settles or closes.
  readonly check: () => void
  // A surface's screen: mounted, first screen drawn, or gone.
  readonly screen: (key: TerminalKey, state: "mounted" | "shown" | "gone") => void
}

const graceMs = 400
const capMs = 15_000

// Boot progress for the splash: the terminals of the session on screen when `begin`
// runs, each attached once the runner has its shell and, where a surface shows it,
// that surface drew its first screen. Failed, closed or waiting terminals count as
// done too, and the splash never waits longer than the cap.
export const createBootProgress = ({
  entry,
  now,
}: {
  readonly entry: (terminalId: string) => BootEntry | undefined
  readonly now: () => number
}): BootProgressTracker => {
  const store = createStore<BootProgress>({ attached: 0, total: 0, done: false })
  let booting: { readonly ids: readonly string[]; readonly since: number } | undefined
  const ready = new Set<string>()
  // Surfaces mounted during boot, and whether they drew a screen yet.
  const screens = new Map<string, boolean>()
  const finished = (id: string): boolean => {
    const current = entry(id)
    return !current || current.closed || current.settled
  }
  // Counted once the runner has its shell; a surface showing it must also have drawn
  // its first screen before boot is done, but the count never goes back while a view
  // that loads late mounts its surfaces.
  const attached = (id: string): boolean => finished(id) || ready.has(id)
  const shown = (id: string): boolean => finished(id) || screens.get(id) !== false
  const check = (): void => {
    if (!booting || store.getSnapshot().done) return
    const count = booting.ids.filter(attached).length
    const total = booting.ids.length
    const waited = now() - booting.since
    const done =
      (count === total && booting.ids.every(shown) && waited >= graceMs) || waited >= capMs
    store.update((current) =>
      current.attached === count && current.total === total && current.done === done
        ? current
        : { attached: count, total, done },
    )
  }
  const begin = (ids: readonly string[]): void => {
    if (booting) return
    booting = { ids, since: now() }
    for (const id of ids) {
      // A fresh shell replaces `ready`; follow the latest one.
      const follow = (): void => {
        const current = entry(id)?.ready
        if (!current) return check()
        void current.then(() => {
          if (entry(id)?.ready !== current) return follow()
          ready.add(id)
          check()
        })
      }
      follow()
    }
    // A little late, since timers may fire a millisecond before the clock agrees.
    setTimeout(check, graceMs + 20)
    setTimeout(check, capMs + 20)
    check()
  }
  const screen: BootProgressTracker["screen"] = ({ terminalId }, state) => {
    if (store.getSnapshot().done) return
    if (state === "gone") screens.delete(terminalId)
    else if (state === "mounted") screens.set(terminalId, screens.get(terminalId) ?? false)
    else screens.set(terminalId, true)
    check()
  }
  return { store, begin, check, screen }
}
