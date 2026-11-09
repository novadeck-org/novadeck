import type { WorkspaceTarget } from "@novadeck/core/types"

import { markReordered } from "../../shell/shell-state"
import type { CommandContext } from "./context"

// Layout changes a view or the sidebar reports. Each takes the target it rendered for.
export type LayoutCommands = {
  readonly setVisibility: (target: WorkspaceTarget, terminalId: string, hidden: boolean) => void
  readonly showAll: (target: WorkspaceTarget, terminalIds: readonly string[]) => void
  readonly reorder: (target: WorkspaceTarget, tabOrder: string[]) => void
}

export const createLayoutCommands = ({
  workspace,
  ui,
}: Pick<CommandContext, "workspace" | "ui">): LayoutCommands => ({
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
    // Canvas arranges its windows by this order, afresh once it has changed; Grid follows it as it
    // is saved.
    if (workspace.dispatch({ type: "terminal/reorder", target, tabOrder }) !== before)
      ui.update((state) => ({ ...state, shell: markReordered(state.shell) }))
  },
})
