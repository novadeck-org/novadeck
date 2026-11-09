import { descendantsOf, leadChain } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import type { Tile, Workspace } from "@novadeck/core/types"
import { useCallback } from "react"

import { foldsAway, isFolded, keepFoldsTogether, toggleFolded } from "../terminals/team-fold"
import type { FoldTeam } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import type { UiState, UiStore } from "./ui-store"

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

// The current session's folds, each lead with the tabs its fold hides (not the one the person is
// on, nor the leads above it, which show in place): what a drag keeps together.
export const foldsOf = (
  workspace: Workspace,
  ui: UiState,
): { readonly lead: string; readonly hidden: readonly string[] }[] => {
  const context = currentContext(workspace)
  const { selected } = currentState(workspace)
  const kept = new Set([selected, ...leadChain(workspace, selected)])
  return (ui.foldedTeams[context] ?? []).map((lead) => ({
    lead,
    hidden: descendantsOf(workspace, lead).filter((id) => !kept.has(id)),
  }))
}

// Saves the order a drag of the Terminals list, or of a tile in Grid, ended on: a drag past a
// folded lead keeps its hidden team right after it.
export const useReorderTiles = (): ((order: string[]) => void) => {
  const { commands, workspace, ui } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  return useCallback(
    (order) =>
      commands.reorder(
        target,
        keepFoldsTogether(order, foldsOf(workspace.getSnapshot(), ui.getSnapshot())),
      ),
    [commands, workspace, ui, target],
  )
}

// The current session's folded leads.
export const useFoldedLeads = (): readonly string[] => {
  const context = useWorkspaceState(currentContext)
  return useUiState((state) => state.foldedTeams[context] ?? noLeads)
}
const noLeads: readonly string[] = []

// How a terminal's tab stands in a fold, for one any lead leads (undefined for a terminal no
// one leads): folded away (a lead above it folded, while the person is elsewhere), previewed
// (a click beside a lead above it would fold it away now), unfolding (a lead above it was just
// unfolded, so it unrolls as it comes back), or shown.
export type TabFold = "away" | "preview" | "unfolding" | "shown"

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
  return useUiState((state): TabFold | undefined => {
    if (!above.length) return undefined
    // On a lead a fold above hides, which shows in its place: its own team shows with it,
    // unless it, or a lead between, is folded itself.
    const peeking =
      underSelected.length > 0 && foldsAway(state.foldedTeams, context, selectedAbove, false)
    const away = peeking
      ? foldsAway(state.foldedTeams, context, underSelected, false)
      : foldsAway(state.foldedTeams, context, above, kept)
    if (away) return "away"
    const under = (mark: { readonly context: string; readonly lead: string } | null) =>
      mark !== null && mark.context === context && above.includes(mark.lead)
    if (
      !kept &&
      under(state.foldPreview) &&
      !isFolded(state.foldedTeams, context, state.foldPreview!.lead)
    )
      return "preview"
    return under(state.unfolding) ? "unfolding" : "shown"
  })
}

// How many leads stand above a terminal: how far its tab steps in (tabs.css).
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
