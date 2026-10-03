import { isWindow } from "../model/roster"
import type { Tile } from "../model/types"
import type { DockTarget } from "../terminals/window-menu"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState } from "./selectors"

// Where a window undocked from a terminal's companion docks back in: the terminal its
// item was shown from, by its name now, absent once it has closed. Undefined for a
// terminal.
export const useDockTarget = (tile: Tile): DockTarget | undefined => {
  const { commands } = useWorkspaceServices()
  const from = useWorkspaceState((workspace) =>
    isWindow(tile)
      ? currentState(workspace).items.find((each) => each.id === tile.itemId)?.from.terminalId
      : undefined,
  )
  const name = useWorkspaceState((workspace) =>
    from === undefined
      ? undefined
      : currentState(workspace).roster.terminals.find((each) => each.id === from)?.name,
  )
  if (!isWindow(tile)) return undefined
  return { name, onDock: name === undefined ? undefined : () => commands.dock(tile.id) }
}
