// What a terminal's screen tells the person about it, and the rule for when typing is
// refused. Pure: it imports nothing.

// A synchronous value that notifies subscribers after each change.
export type Store<S> = {
  readonly getSnapshot: () => S
  readonly subscribe: (listener: () => void) => () => void
}

// A store its owner changes by deriving the next value. A change that returns the same
// value notifies nobody.
export type MutableStore<S> = Store<S> & { readonly update: (change: (state: S) => S) => S }

// The views' own store, for an owner with none to inject: a change that returns the same
// value notifies nobody.
export const createStore = <S>(initial: S): MutableStore<S> => {
  let snapshot = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    update: (change) => {
      const next = change(snapshot)
      if (Object.is(next, snapshot)) return snapshot
      snapshot = next
      listeners.forEach((listener) => listener())
      return snapshot
    },
  }
}

// The shell's stage as the screen needs it: waiting to start, running, or ended and taking
// only Enter, to start again.
export type ViewPhase = "starting" | "running" | "ended"
export type ViewLink = "connected" | "reconnecting" | "unavailable"
export type ViewLock = "starting" | "loading" | "reconnecting" | "offline"

export type ViewState = {
  // A stream draws the current shell; input goes nowhere until one does.
  readonly live: boolean
  // The stream is taking up again after a reconnection.
  readonly resuming: boolean
  // The stream told of an exit before the status did; Enter restarts from then on.
  readonly waits: boolean
  // Why input is refused; null while it takes input.
  readonly lock: ViewLock | null
  // Why the last paste failed, for a few seconds after it did.
  readonly notice: string | null
}

// What the screen is told, apart from the state it keeps.
export type ViewFacts = { readonly link: ViewLink; readonly phase: ViewPhase }
export type ViewChange = Partial<Omit<ViewState, "lock">>

// Input is refused while the host is away, and while a running or starting shell has no
// stream to take it, as right after a reconnection or a restart. An ended shell, and one the
// stream says ended, listen for Enter alone.
export const lockOf = (
  { link, phase }: ViewFacts,
  { live, resuming, waits }: Pick<ViewState, "live" | "resuming" | "waits">,
): ViewLock | null => {
  if (link === "unavailable") return "offline"
  if (link === "reconnecting") return "reconnecting"
  if (phase === "ended" || waits || live) return null
  if (resuming) return "reconnecting"
  return phase === "starting" ? "starting" : "loading"
}

export const openingState = (facts: ViewFacts): ViewState => ({
  live: false,
  resuming: false,
  waits: false,
  lock: lockOf(facts, { live: false, resuming: false, waits: false }),
  notice: null,
})

// The state after `change`, its lock recomputed in the same step, so one change is one
// notification. A change that alters nothing returns `state` itself.
export const nextViewState = (
  state: ViewState,
  change: ViewChange,
  facts: ViewFacts,
): ViewState => {
  const { live, resuming, waits, notice } = { ...state, ...change }
  const lock = lockOf(facts, { live, resuming, waits })
  return live === state.live &&
    resuming === state.resuming &&
    waits === state.waits &&
    notice === state.notice &&
    lock === state.lock
    ? state
    : { live, resuming, waits, lock, notice }
}
