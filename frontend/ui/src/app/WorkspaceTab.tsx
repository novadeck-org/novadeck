import { teamRole, teamText } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { Tile } from "@novadeck/core/types"
import { barMembers, composeBar } from "@novadeck/items/bar"
import { useHasMail, useMailBadge } from "@novadeck/items/mail"
import { TabKinds } from "@novadeck/items/TabKinds"
import { memo, useMemo } from "react"

import { terminalProfile, windowProfile } from "../terminals/processes/profiles"
import { isProjectWindow, projectFolder } from "../terminals/project-window"
import { renameView } from "../terminals/rename-state"
import { TerminalTab } from "../terminals/TerminalTab"
import { unreadEnd } from "../terminals/unread-state"
import { useAskFeedback } from "./ask-feedback"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useDockTarget } from "./dock-target"
import { currentContext, currentState, currentTarget, sameTarget, shallowEqual } from "./selectors"
import { useTerminalBar } from "./terminal-bar"
import { useTerminalMarks } from "./useTerminalMarks"

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
    // Its team in words, which assistive technology hears as the wire is only drawn.
    const teamWords = useWorkspaceState((workspace) => teamText(workspace, id))
    const rename = useUiState(
      (state) =>
        state.rename?.context === context && state.rename.id === id
          ? renameView(state.rename)
          : null,
      shallowEqual,
    )
    const unread = useUiState((state) => unreadEnd(state.unread, context, id))
    // What the raw Inbox says of it: a need, and a done report unseen. Not the landing rule's
    // Inbox, which hides rows from its list, never from the marks.
    const { need, done, subject, dialog } = useTerminalMarks(backend.inbox, {
      ...target,
      terminalId: id,
    })
    // What a window shows, which its icon says.
    const itemId = isWindow(terminal) ? terminal.itemId : undefined
    const item = useWorkspaceState((workspace) =>
      itemId === undefined
        ? undefined
        : currentState(workspace).items.find((each) => each.id === itemId),
    )
    // Where a project window's file is, from its project's folder.
    const directory = useWorkspaceState((workspace) => activeProject(workspace)?.directory)
    const folder =
      isProjectWindow(terminal) && item && directory !== undefined
        ? projectFolder(item.path, directory)
        : undefined
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
    const askFeedback = useAskFeedback(terminal)
    return (
      <TerminalTab
        terminal={terminal}
        icon={(isWindow(terminal) ? windowProfile(item) : terminalProfile(terminal)).icon}
        index={index}
        selected={selected}
        team={team}
        teamWords={teamWords}
        hidden={hidden}
        unread={unread}
        need={need}
        needSubject={subject}
        needDialog={dialog}
        reported={done}
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
        askFeedback={askFeedback}
        folder={folder}
      />
    )
  },
)

export const renderTab = (terminal: Tile, index: number): React.JSX.Element => (
  <WorkspaceTab key={terminal.id} terminal={terminal} index={index} />
)
