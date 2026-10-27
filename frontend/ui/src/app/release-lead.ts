import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import type { ReleaseLead } from "../terminals/window-menu"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentTarget, sameTarget } from "./selectors"

// What a terminal's menu offers to end its lead: only a terminal an agent leads, on a
// backend that lets the person end that. Undefined for anything else.
export const useReleaseLead = (tile: Tile): ReleaseLead | undefined => {
  const { backend } = useWorkspaceServices()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const { releaseLead } = backend
  if (!releaseLead || isWindow(tile) || !tile.ledBy) return undefined
  return {
    lead: tile.ledBy,
    onRelease: () => releaseLead({ ...target, terminalId: tile.id }),
  }
}
