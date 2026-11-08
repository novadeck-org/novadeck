import type { ValueUpdate } from "@novadeck/core/state"
import type { GridLayouts, GridRestoreWidths, WorkspaceTarget } from "@novadeck/core/types"

import { markReordered } from "../../shell/shell-state"
import type { CommandContext } from "./context"

// Layout changes a view reports. Each takes the target the view rendered for: Grid saves
// its layouts when it unmounts after a session switch, and that save belongs to the
// session it showed.
export type LayoutCommands = {
  readonly setGridLayouts: (target: WorkspaceTarget, layouts: ValueUpdate<GridLayouts>) => void
  readonly toggleGridWidth: (
    target: WorkspaceTarget,
    terminalId: string,
    change: { layouts: GridLayouts; restoreWidths: GridRestoreWidths | null },
  ) => void
  readonly setVisibility: (target: WorkspaceTarget, terminalId: string, hidden: boolean) => void
  readonly showAll: (target: WorkspaceTarget, terminalIds: readonly string[]) => void
  readonly reorder: (target: WorkspaceTarget, tabOrder: string[]) => void
}

export const createLayoutCommands = ({
  workspace,
  ui,
}: Pick<CommandContext, "workspace" | "ui">): LayoutCommands => ({
  setGridLayouts: (target, layouts) =>
    void workspace.dispatch({ type: "grid/layouts", target, layouts }),
  toggleGridWidth: (target, terminalId, change) =>
    void workspace.dispatch({ type: "grid/size-toggle", target, terminalId, change }),
  setVisibility: (target, terminalId, hidden) =>
    void workspace.dispatch({ type: "terminal/visibility", target, terminalId, hidden }),
  showAll: (target, terminalIds) =>
    void workspace.transact(
      terminalIds.map((terminalId) => ({
        type: "terminal/visibility",
        target,
        terminalId,
        hidden: false,
      })),
    ),
  reorder: (target, tabOrder) => {
    const before = workspace.getSnapshot()
    // Canvas arranges its windows by this order, afresh once it has changed.
    if (workspace.dispatch({ type: "terminal/reorder", target, tabOrder }) !== before)
      ui.update((state) => ({ ...state, shell: markReordered(state.shell) }))
  },
})
