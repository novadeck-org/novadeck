import { useEffect, useRef, useSyncExternalStore } from "react"

import type { CompanionItem, ItemContent, ItemId } from "../../model/companion"
import type { WorkspaceTarget } from "../../model/types"
import type { PlanDoc } from "./plan-doc"
import type { Panes } from "./state"

// The panes' state as components use it: one part each, so a keystroke in one plan
// re-renders only what shows that plan.

export const usePlan = (panes: Panes, itemId: ItemId): PlanDoc | undefined =>
  useSyncExternalStore(panes.store.subscribe, () => panes.store.getSnapshot().plans[itemId])

const noPlans: Readonly<Record<ItemId, PlanDoc>> = {}

// Only the plans `ids` names, so a keystroke in any other plan re-renders nothing here.
export const usePlans = (
  panes: Panes,
  ids: readonly ItemId[],
): Readonly<Record<ItemId, PlanDoc>> => {
  const last = useRef(noPlans)
  return useSyncExternalStore(panes.store.subscribe, () => {
    const all = panes.store.getSnapshot().plans
    const held = ids.filter((id) => all[id] !== undefined)
    const previous = last.current
    const same =
      Object.keys(previous).length === held.length && held.every((id) => previous[id] === all[id])
    if (!same)
      last.current = held.length
        ? (Object.fromEntries(held.map((id) => [id, all[id]!])) as Record<ItemId, PlanDoc>)
        : noPlans
    return last.current
  })
}

// What an item holds, followed while the component shows it. Undefined until it first
// reports. A plan is followed whether shown or not.
export const useContent = (
  panes: Panes,
  target: WorkspaceTarget,
  item: Pick<CompanionItem, "id" | "kind">,
): ItemContent | undefined => {
  const { projectId, workspaceSessionId } = target
  const { id, kind } = item
  useEffect(
    () => (kind === "plan" ? undefined : panes.watch({ projectId, workspaceSessionId }, id)),
    [panes, projectId, workspaceSessionId, id, kind],
  )
  return useSyncExternalStore(panes.store.subscribe, () => panes.store.getSnapshot().content[id])
}
