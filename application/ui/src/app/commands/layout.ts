import type { ValueUpdate } from "../../model/state"
import type {
  CanvasLayout,
  GridLayouts,
  GridRestoreWidths,
  SizePreset,
  WindowedView,
  WorkspaceTarget,
} from "../../model/types"
import type { CommandContext } from "./context"

// Layout changes a view reports. Each takes the target the view rendered for: Canvas
// saves geometry when it unmounts after a session switch, and that save belongs to
// the session it showed.
export type LayoutCommands = {
  readonly setCanvasLayout: (target: WorkspaceTarget, layout: ValueUpdate<CanvasLayout>) => void
  readonly setGridLayouts: (target: WorkspaceTarget, layouts: ValueUpdate<GridLayouts>) => void
  readonly toggleGridWidth: (
    target: WorkspaceTarget,
    terminalId: string,
    change: { layouts: GridLayouts; restoreWidths: GridRestoreWidths | null },
  ) => void
  readonly toggleGridMinimized: (target: WorkspaceTarget, terminalId: string) => void
  readonly setSizePreset: (
    target: WorkspaceTarget,
    terminalId: string,
    view: WindowedView,
    preset: SizePreset,
  ) => void
  readonly setVisibility: (target: WorkspaceTarget, terminalId: string, hidden: boolean) => void
  readonly showAll: (target: WorkspaceTarget, terminalIds: readonly string[]) => void
  readonly reorder: (target: WorkspaceTarget, tabOrder: string[]) => void
}

export const createLayoutCommands = ({
  workspace,
}: Pick<CommandContext, "workspace">): LayoutCommands => ({
  setCanvasLayout: (target, layout) =>
    void workspace.dispatch({ type: "canvas/layout", target, layout }),
  setGridLayouts: (target, layouts) =>
    void workspace.dispatch({ type: "grid/layouts", target, layouts }),
  toggleGridWidth: (target, terminalId, change) =>
    void workspace.dispatch({ type: "grid/size-toggle", target, terminalId, change }),
  toggleGridMinimized: (target, terminalId) =>
    void workspace.dispatch({ type: "grid/minimize", target, terminalId }),
  setSizePreset: (target, terminalId, view, preset) =>
    void workspace.dispatch({ type: "terminal/size-preset", target, terminalId, view, preset }),
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
  reorder: (target, tabOrder) =>
    void workspace.dispatch({ type: "terminal/reorder", target, tabOrder }),
})
