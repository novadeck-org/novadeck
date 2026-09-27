import { useEffect, useMemo, useState, useSyncExternalStore } from "react"

import type { Store } from "../../model/store"

// The value a component last committed, so a new selector can keep it when equal.
type Committed<T> = {
  readonly latest: () => { readonly value: T } | null
  readonly remember: (value: T) => void
}

const createCommitted = <T>(): Committed<T> => {
  let latest: { value: T } | null = null
  return {
    latest: () => latest,
    remember: (value) => {
      latest = { value }
    },
  }
}

// Reads the selection for the store's current snapshot, reusing it while the snapshot
// is unchanged and keeping the previous value when a new one is equal to it.
const selectionReader = <S, T>(
  store: Store<S>,
  select: (state: S) => T,
  equal: (a: T, b: T) => boolean,
  committed: Committed<T>,
): (() => T) => {
  let memo: { snapshot: S; selection: T } | null = null
  return () => {
    const snapshot = store.getSnapshot()
    if (memo && Object.is(memo.snapshot, snapshot)) return memo.selection
    const next = select(snapshot)
    const previous = memo ? { value: memo.selection } : committed.latest()
    const selection = previous && equal(previous.value, next) ? previous.value : next
    memo = { snapshot, selection }
    return selection
  }
}

// Subscribes to one derived value of a store and re-renders only when it changes.
// A port of React's `useSyncExternalStoreWithSelector` shim.
export const useStoreSelector = <S, T>(
  store: Store<S>,
  select: (state: S) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T => {
  const [committed] = useState(createCommitted<T>)
  const read = useMemo(
    () => selectionReader(store, select, equal, committed),
    [store, select, equal, committed],
  )
  const value = useSyncExternalStore(store.subscribe, read)
  useEffect(() => committed.remember(value), [committed, value])
  return value
}
