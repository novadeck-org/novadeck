import { isOnBar, type CompanionItem, type ItemId } from "../model/companion"
import { emptyBar, type Bar } from "../model/companion-bar"
import { useWorkspaceState } from "./controller/context"
import { currentState, sameItems, shallowEqual } from "./selectors"

const noItems: readonly CompanionItem[] = []

// What a terminal's bar holds, as the person arranged it, and what's new there: for its
// window's taskbar and its sidebar tab alike.
export type TerminalBar = {
  readonly bar: Bar
  readonly items: readonly CompanionItem[]
  readonly fresh: Readonly<Record<ItemId, true>>
}

export const useTerminalBar = (terminalId: string): TerminalBar => {
  const bar = useWorkspaceState((workspace) => currentState(workspace).bars[terminalId] ?? emptyBar)
  const items = useWorkspaceState((workspace) => {
    const held = currentState(workspace).items.filter((item) => isOnBar(item, terminalId))
    return held.length ? held : noItems
  }, sameItems)
  // Only its own items' marks, so something new on another bar re-renders nothing here.
  const fresh = useWorkspaceState((workspace): Readonly<Record<ItemId, true>> => {
    const state = currentState(workspace)
    return Object.fromEntries(
      state.items.flatMap((item) =>
        isOnBar(item, terminalId) && state.fresh[item.id] ? [[item.id, true]] : [],
      ),
    )
  }, shallowEqual)
  return { bar, items, fresh }
}
