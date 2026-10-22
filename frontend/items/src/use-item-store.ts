import { kindRules, type Item, type ItemContent, type ItemId } from "@novadeck/core/items"
import type { WorkspaceTarget } from "@novadeck/core/types"
import { useEffect, useRef, useSyncExternalStore } from "react"

import type { PlanDoc } from "./kinds/plan/plan-doc"
import type { ItemStore } from "./state"

// The item store's state as components use it: one part each, so a keystroke in one plan
// re-renders only what shows that plan.

export const usePlan = (itemStore: ItemStore, itemId: ItemId): PlanDoc | undefined =>
  useSyncExternalStore(itemStore.store.subscribe, () => itemStore.store.getSnapshot().plans[itemId])

const noPlans: Readonly<Record<ItemId, PlanDoc>> = {}

// Only the plans `ids` names, so a keystroke in any other plan re-renders nothing here.
export const usePlans = (
  itemStore: ItemStore,
  ids: readonly ItemId[],
): Readonly<Record<ItemId, PlanDoc>> => {
  const last = useRef(noPlans)
  return useSyncExternalStore(itemStore.store.subscribe, () => {
    const all = itemStore.store.getSnapshot().plans
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
  itemStore: ItemStore,
  target: WorkspaceTarget,
  item: Pick<Item, "id" | "kind">,
): ItemContent | undefined => {
  const { projectId, workspaceSessionId } = target
  const { id, kind } = item
  useEffect(
    () =>
      kindRules[kind].follow === "always"
        ? undefined
        : itemStore.watch({ projectId, workspaceSessionId }, id),
    [itemStore, projectId, workspaceSessionId, id, kind],
  )
  return useSyncExternalStore(
    itemStore.store.subscribe,
    () => itemStore.store.getSnapshot().content[id],
  )
}
