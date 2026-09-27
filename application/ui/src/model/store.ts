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
