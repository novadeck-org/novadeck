import { leadChain, teamOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import { foldsAway, isFolded, toggleFolded } from "../terminals/team-fold"
import type { FoldTeam } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, sameItems } from "./selectors"
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
  // The leads above it, and whether the person is on it or on one below it (which keeps it
  // and the leads between in place); not which terminal is selected, so a change of
  // selection elsewhere re-renders no tab.
  const { above, kept } = useWorkspaceState(
    (workspace) => {
      const selected = currentState(workspace).selected
      return {
        above: leadChain(workspace, id),
        kept: selected === id || leadChain(workspace, selected).includes(id),
      }
    },
    (a, b) => a.kept === b.kept && sameItems(a.above, b.above),
  )
  return useUiState((state): TabFold | undefined => {
    if (!above.length) return undefined
    if (foldsAway(state.foldedTeams, context, above, kept)) return "away"
    const under = (mark: { readonly context: string; readonly lead: string } | null) =>
      mark !== null && mark.context === context && above.includes(mark.lead)
    if (under(state.foldPreview) && !isFolded(state.foldedTeams, context, state.foldPreview!.lead))
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
  const count = useWorkspaceState((workspace) => {
    const team = teamOf(workspace, tile.id)
    return team?.lead === tile.id ? team.workers.length : 0
  })
  const folded = useUiState((state) => isFolded(state.foldedTeams, context, tile.id))
  if (isWindow(tile) || !count) return undefined
  return { count, folded, onToggle: () => toggleTeamFold(ui, context, tile.id) }
}
