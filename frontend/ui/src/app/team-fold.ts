import { descendantsOf, leadChain } from "@novadeck/core/derivations"
import { isWindow, keepFoldsTogether } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"
import { isFolded, rowFold, type RowFold } from "@novadeck/toolkit/team-fold"
import { useCallback } from "react"

import { toggleFolded } from "../terminals/team-fold"
import type { FoldTeam } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import {
  currentContext,
  currentState,
  currentTarget,
  foldsOf,
  sameItems,
  sameTarget,
} from "./selectors"
import type { UiStore } from "./ui-store"

// How long a team counts as folding or unfolding once the person turned it over: past the
// motion, so a tab or row that mounts later, as on a session switch or the sidebar shown
// again, appears at once.
const motionMs = 1000

// Folds the lead's team in the current session, or shows it again.
export const toggleTeamFold = (ui: UiStore, context: string, lead: string): void => {
  const unfolds = isFolded(ui.getSnapshot().foldedTeams, context, lead)
  const moving = { context, lead }
  ui.update((state) => ({
    ...state,
    foldedTeams: toggleFolded(state.foldedTeams, context, lead),
    foldPreview: null,
    unfolding: unfolds ? moving : null,
    folding: unfolds ? null : moving,
  }))
  setTimeout(
    () =>
      ui.update((state) =>
        state.unfolding === moving || state.folding === moving
          ? {
              ...state,
              unfolding: state.unfolding === moving ? null : state.unfolding,
              folding: state.folding === moving ? null : state.folding,
            }
          : state,
      ),
    motionMs,
  )
}

// Says which lead's fold the person points at, beside its tab, or that they point at none.
export const previewTeamFold = (ui: UiStore, preview: UiStoreFoldPreview): void =>
  void ui.update((state) =>
    state.foldPreview?.lead === preview?.lead && state.foldPreview?.context === preview?.context
      ? state
      : { ...state, foldPreview: preview },
  )

type UiStoreFoldPreview = { readonly context: string; readonly lead: string } | null

// Applies the folds to an order: each folded lead's hidden tabs right after it, as a drag of the
// Terminals list or of a tile in Grid saves it, so Grid shows the order a drop will save.
export const useFoldedOrder = (): ((order: readonly string[]) => string[]) => {
  const { workspace, ui } = useWorkspaceServices()
  return useCallback(
    (order) =>
      keepFoldsTogether(order, foldsOf(workspace.getSnapshot(), ui.getSnapshot().foldedTeams)),
    [workspace, ui],
  )
}

// Saves the order a drag of the Terminals list, or of a tile in Grid, ended on: a drag past a
// folded lead keeps its hidden team right after it.
export const useReorderTiles = (): ((order: string[]) => void) => {
  const { commands } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const folded = useFoldedOrder()
  return useCallback((order) => commands.reorder(target, folded(order)), [commands, target, folded])
}

// The current session's folded leads.
export const useFoldedLeads = (): readonly string[] => {
  const context = useWorkspaceState(currentContext)
  return useUiState((state) => state.foldedTeams[context] ?? noLeads)
}
const noLeads: readonly string[] = []

// How a terminal's tab stands in a fold (rowFold).
export type TabFold = RowFold

export const useTabFold = (id: string): TabFold | undefined => {
  const context = useWorkspaceState(currentContext)
  // The leads above it, whether the person is on it or on one below it (which keeps it and the
  // leads between in place), and while the person is on a lead above it, the leads from it up
  // to that one (whose own folds still count, as the lead shows its own team while there);
  // not which terminal is selected, so a change of selection elsewhere re-renders no tab.
  const { above, kept, underSelected, selectedAbove } = useWorkspaceState(
    (workspace) => {
      const selected = currentState(workspace).selected
      const chain = leadChain(workspace, id)
      const at = chain.indexOf(selected)
      return {
        above: chain,
        kept: selected === id || leadChain(workspace, selected).includes(id),
        underSelected: at < 0 ? noLeads : chain.slice(0, at + 1),
        selectedAbove: at < 0 ? noLeads : leadChain(workspace, selected),
      }
    },
    (a, b) =>
      a.kept === b.kept &&
      sameItems(a.above, b.above) &&
      sameItems(a.underSelected, b.underSelected) &&
      sameItems(a.selectedAbove, b.selectedAbove),
  )
  return useUiState((state) =>
    rowFold({
      folded: state.foldedTeams,
      context,
      above,
      kept,
      underSelected,
      selectedAbove,
      preview: state.foldPreview,
      unfolding: state.unfolding,
    }),
  )
}

// How many leads stand above a terminal: how far its tab steps in (the toolkit's team-rows.css).
export const useTeamLevel = (id: string): number =>
  useWorkspaceState((workspace) => leadChain(workspace, id).length)

// What a lead's menu offers to fold its team or show it again; undefined for a terminal that
// leads none, and for a window.
export const useFoldTeam = (tile: Tile): FoldTeam | undefined => {
  const { ui } = useWorkspaceServices()
  const context = useWorkspaceState(currentContext)
  // Every terminal the fold hides, at any depth.
  const count = useWorkspaceState((workspace) => descendantsOf(workspace, tile.id).length)
  const folded = useUiState((state) => isFolded(state.foldedTeams, context, tile.id))
  if (isWindow(tile) || !count) return undefined
  return { count, folded, onToggle: () => toggleTeamFold(ui, context, tile.id) }
}
