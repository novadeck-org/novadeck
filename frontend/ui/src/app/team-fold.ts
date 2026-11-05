import { teamOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import { foldsAway, isFolded, toggleFolded } from "../terminals/team-fold"
import type { FoldTeam } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState } from "./selectors"
import type { UiStore } from "./ui-store"

// How long a team's tabs count as unfolding once it's shown again: past the unroll, so a tab
// that mounts later, as on a session switch or the sidebar shown again, appears at once.
const unfoldingMs = 1000

// Folds the lead's team in the current session, or shows it again.
export const toggleTeamFold = (ui: UiStore, context: string, lead: string): void => {
  const unfolds = isFolded(ui.getSnapshot().foldedTeams, context, lead)
  const unfolding = unfolds ? { context, lead } : null
  ui.update((state) => ({
    ...state,
    foldedTeams: toggleFolded(state.foldedTeams, context, lead),
    foldPreview: null,
    unfolding,
  }))
  if (unfolding)
    setTimeout(
      () =>
        ui.update((state) =>
          state.unfolding === unfolding ? { ...state, unfolding: null } : state,
        ),
      unfoldingMs,
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

// The current session's folded leads.
export const useFoldedLeads = (): readonly string[] => {
  const context = useWorkspaceState(currentContext)
  return useUiState((state) => state.foldedTeams[context] ?? noLeads)
}
const noLeads: readonly string[] = []

// How a terminal's tab stands in a fold, for a teammate (undefined for a lead or a terminal in
// no team): folded away (its lead folded, while the person is elsewhere), previewed (a click
// beside its lead would fold it away now), unfolding (its lead's team was just unfolded, so it
// unrolls as it comes back), or shown.
export type TabFold = "away" | "preview" | "unfolding" | "shown"

export const useTabFold = (id: string): TabFold | undefined => {
  const context = useWorkspaceState(currentContext)
  // Whether it's the selected terminal, not which one is, so a change of selection elsewhere
  // re-renders no tab.
  const { lead, selected } = useWorkspaceState(
    (workspace) => {
      const team = teamOf(workspace, id)
      return {
        lead: team?.lead === id ? undefined : team?.lead,
        selected: currentState(workspace).selected === id,
      }
    },
    (a, b) => a.lead === b.lead && a.selected === b.selected,
  )
  return useUiState((state): TabFold | undefined => {
    if (lead === undefined) return undefined
    if (foldsAway(state.foldedTeams, context, { lead }, id, selected ? id : "")) return "away"
    const at = (mark: { readonly context: string; readonly lead: string } | null) =>
      mark?.context === context && mark.lead === lead
    if (at(state.foldPreview) && !isFolded(state.foldedTeams, context, lead)) return "preview"
    return at(state.unfolding) ? "unfolding" : "shown"
  })
}

// What a lead's menu offers to fold its team or show it again; undefined for a terminal that
// leads none, and for a window.
export const useFoldTeam = (tile: Tile): FoldTeam | undefined => {
  const { ui } = useWorkspaceServices()
  const context = useWorkspaceState(currentContext)
  const count = useWorkspaceState((workspace) => {
    const team = teamOf(workspace, tile.id)
    return team?.lead === tile.id ? team.workers.length : 0
  })
  const folded = useUiState((state) => isFolded(state.foldedTeams, context, tile.id))
  if (isWindow(tile) || !count) return undefined
  return { count, folded, onToggle: () => toggleTeamFold(ui, context, tile.id) }
}
