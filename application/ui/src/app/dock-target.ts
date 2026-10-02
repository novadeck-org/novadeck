import type { TerminalMetadata } from "../model/types"
import type { DockTarget } from "../terminals/window-menu"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentState } from "./selectors"

// Where a window undocked from a terminal's companion docks back in: that terminal, by
// its name now, absent once it has closed. Undefined for any other window.
export const useDockTarget = (terminal: TerminalMetadata): DockTarget | undefined => {
  const { commands } = useWorkspaceServices()
  const from = terminal.companion?.from
  const name = useWorkspaceState((workspace) =>
    from === undefined
      ? undefined
      : currentState(workspace).roster.terminals.find((each) => each.id === from)?.name,
  )
  if (from === undefined) return undefined
  return { name, onDock: name === undefined ? undefined : () => commands.dock(terminal.id) }
}
