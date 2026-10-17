import { workspaceReducer, type WorkspaceAction } from "./state"
import type { Workspace } from "./types"

// A synchronous value that notifies subscribers after each change.
export type Store<S> = {
  readonly getSnapshot: () => S
  readonly subscribe: (listener: () => void) => () => void
}

// A store its owner changes by deriving the next value. A change that returns the
// same value notifies nobody.
export type MutableStore<S> = Store<S> & { readonly update: (change: (state: S) => S) => S }

const createListeners = () => {
  const listeners = new Set<() => void>()
  return {
    notify: (): void => listeners.forEach((listener) => listener()),
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export const createStore = <S>(initial: S): MutableStore<S> => {
  let snapshot = initial
  const { notify, subscribe } = createListeners()
  return {
    getSnapshot: () => snapshot,
    subscribe,
    update: (change) => {
      const next = change(snapshot)
      if (Object.is(next, snapshot)) return snapshot
      snapshot = next
      notify()
      return snapshot
    },
  }
}

export type WorkspaceTransaction =
  | readonly WorkspaceAction[]
  | ((workspace: Workspace) => readonly WorkspaceAction[])

export type WorkspaceStore = Store<Workspace> & {
  readonly dispatch: (action: WorkspaceAction) => Workspace
  // Reduces every action against the latest snapshot and publishes the result once.
  readonly transact: (transaction: WorkspaceTransaction) => Workspace
}

export const createWorkspaceStore = (
  initial: Workspace,
  onCommit?: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void,
): WorkspaceStore => {
  let snapshot = initial
  let committing = false
  const { notify, subscribe } = createListeners()
  const transact = (transaction: WorkspaceTransaction): Workspace => {
    // A commit hook that starts another transaction would see its own commit out of order.
    if (committing) throw new Error("A workspace transaction cannot start inside a commit")
    const actions = typeof transaction === "function" ? transaction(snapshot) : transaction
    const next = actions.reduce(workspaceReducer, snapshot)
    if (next === snapshot) return snapshot
    snapshot = next
    committing = true
    try {
      onCommit?.(snapshot, actions)
    } finally {
      // The snapshot has advanced either way, so subscribers must hear about it.
      committing = false
      notify()
    }
    return snapshot
  }
  return {
    getSnapshot: () => snapshot,
    subscribe,
    dispatch: (action) => transact([action]),
    transact,
  }
}

// A store that hands out, beside the whole value, one entry of it by key. An entry's
// subscribers hear of a change only when their entry changed, however many others did,
// so a reader of one entry costs nothing when the rest change. The whole value's
// subscribers hear of every change, as with `createStore`.
export type KeyedStore<S, K, V> = MutableStore<S> & { readonly entry: (key: K) => Store<V> }

// `read` finds a key's entry in a value, and `name` tells keys apart.
export const createKeyedStore = <S, K, V>(
  initial: S,
  read: (state: S, key: K) => V,
  name: (key: K) => string,
): KeyedStore<S, K, V> => {
  const whole = createStore(initial)
  // The entries someone subscribes to, by name, with how many subscribe.
  const watched = new Map<
    string,
    { readonly key: K; readonly listeners: ReturnType<typeof createListeners>; count: number }
  >()
  const update = (change: (state: S) => S): S => {
    const previous = whole.getSnapshot()
    const next = whole.update(change)
    if (Object.is(next, previous)) return next
    for (const each of watched.values())
      if (!Object.is(read(previous, each.key), read(next, each.key))) each.listeners.notify()
    return next
  }
  const entry = (key: K): Store<V> => ({
    getSnapshot: () => read(whole.getSnapshot(), key),
    subscribe: (listener) => {
      const id = name(key)
      const each = watched.get(id) ?? { key, listeners: createListeners(), count: 0 }
      watched.set(id, each)
      const stop = each.listeners.subscribe(listener)
      each.count += 1
      let subscribed = true
      return () => {
        if (!subscribed) return
        subscribed = false
        stop()
        each.count -= 1
        if (each.count === 0) watched.delete(id)
      }
    },
  })
  return { getSnapshot: whole.getSnapshot, subscribe: whole.subscribe, update, entry }
}
