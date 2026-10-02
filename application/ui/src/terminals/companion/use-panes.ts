import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { ArtifactContent, CompanionKey } from "../../model/companion"
import type { Pane, Shown } from "./pane"
import type { PaneActions, PaneMap, Panes } from "./state"

// A terminal's pane as its components use it: as it stands, and what changes it.
export type PaneHandle = PaneActions & { readonly pane: Pane }

export const usePane = (panes: Panes, key: CompanionKey): PaneHandle => {
  const actions = panes.of(key)
  const pane = useSyncExternalStore(panes.store.subscribe, actions.current)
  return { ...actions, pane }
}

const noPanes: PaneMap = {}

// Only the panes of the terminals `ids` names, so a change to any other pane, as a
// keystroke in its plan, re-renders nothing here.
export const usePanesOf = (panes: Panes, ids: readonly string[]): PaneMap => {
  const last = useRef<PaneMap>(noPanes)
  const select = (): PaneMap => {
    const all = panes.store.getSnapshot()
    const held = ids.filter((id) => all[id] !== undefined)
    const previous = last.current
    const same =
      Object.keys(previous).length === held.length && held.every((id) => previous[id] === all[id])
    if (!same)
      last.current = held.length ? Object.fromEntries(held.map((id) => [id, all[id]!])) : noPanes
    return last.current
  }
  return useSyncExternalStore(panes.store.subscribe, select)
}

export type ArtifactLoad =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: ArtifactContent }
  | { readonly status: "failed" }

// An artifact's content, loading on first use.
export const useArtifactContent = (
  load: (artifact: Shown) => Promise<ArtifactContent>,
  artifact: Shown,
): ArtifactLoad => {
  const [state, setState] = useState<{ readonly for: string; readonly state: ArtifactLoad }>({
    for: "",
    state: { status: "loading" },
  })
  const which = `${artifact.id}@${artifact.version}`
  useEffect(() => {
    let current = true
    load(artifact).then(
      (content) => current && setState({ for: which, state: { status: "ready", content } }),
      () => current && setState({ for: which, state: { status: "failed" } }),
    )
    return () => {
      current = false
    }
    // The artifact's identity and version decide what loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [which])
  return state.for === which ? state.state : { status: "loading" }
}
