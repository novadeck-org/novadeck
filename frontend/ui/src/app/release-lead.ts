import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import type { ReleaseLead } from "../terminals/window-menu"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState, currentTarget, sameTarget } from "./selectors"

// What a terminal's menu offers to end its lead: only a terminal an agent leads, on a
// backend that lets the person end that, while its shell runs: the runner has nothing
// to release on one that is still starting or has ended. The lead is named by its handle where
// the session still has it, else not at all. Undefined for anything else.
export const useReleaseLead = (tile: Tile): ReleaseLead | undefined => {
  const { backend } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const leadId = isWindow(tile) ? null : (tile.ledBy ?? null)
  const lead = useWorkspaceState((workspace) =>
    leadId === null
      ? undefined
      : currentState(workspace).roster.terminals.find((each) => each.id === leadId)?.handle,
  )
  const { releaseLead } = backend
  if (
    !releaseLead ||
    isWindow(tile) ||
    !tile.ledBy ||
    tile.state === "starting" ||
    tile.state === "exited" ||
    tile.state === "failed"
  )
    return undefined
  return {
    lead: lead ?? null,
    onRelease: () => releaseLead({ ...target, terminalId: tile.id }),
  }
}
