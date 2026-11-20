import type { Store } from "@novadeck/core/store"
import { useRef, useSyncExternalStore } from "react"

/**
 * One derived value of a store, re-rendering only as it changes: worked out again when the
 * store's snapshot or the selector changes, and kept as it was while `equal` holds.
 */
export const useSelected = <S, T>(
  store: Store<S>,
  select: (state: S) => T,
  equal: (a: T, b: T) => boolean = Object.is,
): T => {
  const last = useRef<{ snapshot: S; select: (state: S) => T; value: T } | null>(null)
  return useSyncExternalStore(store.subscribe, () => {
    const snapshot = store.getSnapshot()
    const before = last.current
    if (before && before.snapshot === snapshot && before.select === select) return before.value
    const next = select(snapshot)
    const value = before && equal(before.value, next) ? before.value : next
    last.current = { snapshot, select, value }
    return value
  })
}
