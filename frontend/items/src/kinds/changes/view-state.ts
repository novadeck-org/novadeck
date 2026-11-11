import { useCallback, useEffect, useState } from "react"

import type { Picked } from "./selection"

// What the person has done in a change's pane, kept by item for as long as the session lives, so
// a change shown again is as they left it: the layers picked, the file unfolded or opened, the
// folders folded and the files read (each by what it was when it was read).

export type ChangesView = {
  readonly picked: Picked
  readonly unfolded: string | null
  readonly open: string | null
  readonly folded: readonly string[]
  readonly read: Readonly<Record<string, string>>
}

export const freshView: ChangesView = {
  picked: [],
  unfolded: null,
  open: null,
  folded: [],
  read: {},
}

// By the item store of the session, which a session that goes takes with it.
const kept = new WeakMap<object, Map<string, ChangesView>>()
const keptBy = (scope: object): Map<string, ChangesView> => {
  const known = kept.get(scope)
  if (known) return known
  const made = new Map<string, ChangesView>()
  kept.set(scope, made)
  return made
}

/** The item's view, and a way to change it. */
export const useChangesView = (
  scope: object,
  itemId: string,
): readonly [ChangesView, (change: (view: ChangesView) => ChangesView) => void] => {
  const [view, setView] = useState(() => keptBy(scope).get(itemId) ?? freshView)
  useEffect(() => {
    keptBy(scope).set(itemId, view)
  }, [scope, itemId, view])
  const update = useCallback((change: (view: ChangesView) => ChangesView) => setView(change), [])
  return [view, update]
}
