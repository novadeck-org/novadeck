import type { TerminalMetadata } from "../model/types"
import { renameView } from "../terminals/rename-state"
import { TerminalTab } from "../terminals/TerminalTab"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget, sameTarget, shallowEqual } from "./selectors"

// One terminal's sidebar tab. It selects only what concerns its own terminal, so a
// rename keystroke re-renders the tab being renamed and no other.
export const WorkspaceTab = ({
  terminal,
  index,
}: {
  readonly terminal: TerminalMetadata
  readonly index: number
}): React.JSX.Element => {
  const { commands } = useWorkspaceServices()
  const { id } = terminal
  const { context, selected, hidden } = useWorkspaceState((workspace) => {
    const { selected: current, layout } = currentState(workspace)
    return {
      context: currentContext(workspace),
      selected: current === id,
      hidden: layout.hidden[id] ?? false,
    }
  }, shallowEqual)
  const target = useWorkspaceState(currentTarget, sameTarget)
  const rename = useUiState(
    (state) =>
      state.rename?.context === context && state.rename.id === id ? renameView(state.rename) : null,
    shallowEqual,
  )
  return (
    <TerminalTab
      terminal={terminal}
      index={index}
      selected={selected}
      hidden={hidden}
      rename={rename}
      onVisibilityChange={(isHidden) => commands.setVisibility(target, id, isHidden)}
      onSelect={() => commands.select(id)}
      onBeginRename={() => commands.startRename(terminal, "sidebar")}
      onRenameDraft={(value) => commands.changeRenameDraft(id, value)}
      onRenameSave={() => commands.saveRename(id)}
      onRenameCancel={() => commands.cancelRename(id)}
      onClose={() => commands.close(id)}
    />
  )
}

export const renderTab = (terminal: TerminalMetadata, index: number): React.JSX.Element => (
  <WorkspaceTab key={terminal.id} terminal={terminal} index={index} />
)
