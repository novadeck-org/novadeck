import { barMembers, composeBar } from "@novadeck/companion/bar"
import { useHasMail, useMailBadge } from "@novadeck/companion/mail"
import { TabKinds } from "@novadeck/companion/TabKinds"
import { teamRole } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import type { Tile } from "@novadeck/core/types"
import { memo, useMemo } from "react"

import { terminalProfile, windowProfile } from "../terminals/processes/profiles"
import { renameView } from "../terminals/rename-state"
import { TerminalTab } from "../terminals/TerminalTab"
import { unreadEnd } from "../terminals/unread-state"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useDockTarget } from "./dock-target"
import { currentContext, currentState, currentTarget, sameTarget, shallowEqual } from "./selectors"
import { useTerminalBar } from "./terminal-bar"

// One terminal's or window's sidebar tab. It selects only what concerns its own tile, so
// a rename keystroke re-renders the tab being renamed and no other.
export const WorkspaceTab = memo(
  ({ terminal, index }: { readonly terminal: Tile; readonly index: number }): React.JSX.Element => {
    const { commands, backend } = useWorkspaceServices()
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
    // Its place in the selected terminal's team, which the tab and the rail's wire show.
    const team = useWorkspaceState((workspace) => teamRole(workspace, id))
    const rename = useUiState(
      (state) =>
        state.rename?.context === context && state.rename.id === id
          ? renameView(state.rename)
          : null,
      shallowEqual,
    )
    const unread = useUiState((state) => unreadEnd(state.unread, context, id))
    // What a window shows, which its icon says.
    const itemId = isWindow(terminal) ? terminal.itemId : undefined
    const item = useWorkspaceState((workspace) =>
      itemId === undefined
        ? undefined
        : currentState(workspace).items.find((each) => each.id === itemId),
    )
    const companionKey = { ...target, terminalId: id }
    const badge = useMailBadge(backend.messages, companionKey)
    // What its companion bar holds, as the bar itself draws it.
    const hasMail = useHasMail(backend.messages, companionKey)
    const { bar, items, fresh } = useTerminalBar(id)
    const slots = useMemo(
      () => composeBar(bar, barMembers({ terminalId: id, bar, items, fresh, messages: hasMail })),
      [id, bar, items, fresh, hasMail],
    )
    const dockIn = useDockTarget(terminal)
    return (
      <TerminalTab
        terminal={terminal}
        icon={(isWindow(terminal) ? windowProfile(item) : terminalProfile(terminal)).icon}
        index={index}
        selected={selected}
        team={team}
        hidden={hidden}
        unread={unread}
        rename={rename}
        mail={badge}
        companion={<TabKinds slots={slots} mail={badge !== null} />}
        onVisibilityChange={(isHidden) => commands.setVisibility(target, id, isHidden)}
        onSelect={() => commands.select(id)}
        onBeginRename={() => commands.startRename(terminal, "sidebar")}
        onRenameDraft={(value) => commands.changeRenameDraft(id, value)}
        onRenameSave={() => commands.saveRename(id)}
        onRenameCancel={() => commands.cancelRename(id)}
        onClose={() => commands.close(id)}
        {...(backend.resetTitle ? { onResetTitle: () => commands.resetTitle(id) } : {})}
        dockIn={dockIn}
      />
    )
  },
)

export const renderTab = (terminal: Tile, index: number): React.JSX.Element => (
  <WorkspaceTab key={terminal.id} terminal={terminal} index={index} />
)
