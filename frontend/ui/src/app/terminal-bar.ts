import { isOnBar, type Item, type ItemId } from "@novadeck/core/items"
import { emptyBar, type Bar } from "@novadeck/core/items/companion-bar"
import type { AgentShell } from "@novadeck/core/types"

import { useWorkspaceState } from "./controller/context"
import { currentState, sameItems, shallowEqual } from "./selectors"

const noItems: readonly Item[] = []

// What a terminal's bar holds, as the person arranged it, and what's new there: for its
// window's taskbar and its sidebar tab alike.
export type TerminalBar = {
  readonly bar: Bar
  readonly items: readonly Item[]
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

// Where a terminal's shells item is, wherever the person moved it (to another bar, or a window
// of its own): its id, and the terminal whose bar holds it, null in a window.
export type ShellsHome = { readonly id: ItemId; readonly bar: string | null }

export const useShellsHome = (terminalId: string): ShellsHome | undefined =>
  useWorkspaceState((workspace) => {
    const item = currentState(workspace).items.find(
      (each) => each.kind === "shells" && each.from?.terminalId === terminalId,
    )
    return item && { id: item.id, bar: "terminalId" in item.holder ? item.holder.terminalId : null }
  }, shallowEqual)

const noShells: Readonly<Record<string, readonly AgentShell[]>> = {}

// The background shells of the agents of the terminals the shells items on a terminal's bar are
// from, by terminal id: each item's are its own terminal's. Nothing on the bar draws them now;
// they're kept for a mark to come.
export const useBarShells = (terminalId: string): Readonly<Record<string, readonly AgentShell[]>> =>
  useWorkspaceState((workspace) => {
    const state = currentState(workspace)
    const shells: Record<string, readonly AgentShell[]> = {}
    for (const item of state.items) {
      if (item.kind !== "shells" || !isOnBar(item, terminalId) || !item.from) continue
      const from = state.roster.terminals.find((each) => each.id === item.from!.terminalId)
      const listed = from?.state === "running" ? from.agent?.shells : undefined
      if (listed) shells[item.from.terminalId] = listed
    }
    return Object.keys(shells).length > 0 ? shells : noShells
  }, shallowEqual)
