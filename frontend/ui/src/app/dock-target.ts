import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"

import { isProjectWindow } from "../terminals/project-window"
import type { DockTarget } from "../terminals/window-menu"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState } from "./selectors"

// Where a window undocked from a terminal's companion docks back in: the terminal its
// item was shown from, by its name now, absent once it has closed. Undefined for a
// terminal, and for the project window, which came from none.
export const useDockTarget = (tile: Tile): DockTarget | undefined => {
  const { commands } = useWorkspaceServices()
  const from = useWorkspaceState((workspace) =>
    isWindow(tile)
      ? currentState(workspace).items.find((each) => each.id === tile.itemId)?.from?.terminalId
      : undefined,
  )
  const name = useWorkspaceState((workspace) =>
    from === undefined
      ? undefined
      : currentState(workspace).roster.terminals.find((each) => each.id === from)?.name,
  )
  if (!isWindow(tile) || isProjectWindow(tile)) return undefined
  return { name, onDock: name === undefined ? undefined : () => commands.dock(tile.id) }
}
