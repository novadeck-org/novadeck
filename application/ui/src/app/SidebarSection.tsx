import { memo } from "react"

import { orderedTiles } from "../model/roster"
import { activeProject } from "../model/state"
import type { WorkspaceSession } from "../model/types"
import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import {
  currentContext,
  currentState,
  currentTarget,
  sameItems,
  sameTarget,
  shallowEqual,
} from "./selectors"
import { useNotifications } from "./useNotifications"
import { renderTab } from "./WorkspaceTab"

// The Sessions panel shows each session's name, visit time and terminals, nothing else.
const sameSessions = (a: readonly WorkspaceSession[], b: readonly WorkspaceSession[]): boolean =>
  a.length === b.length &&
  a.every((session, index) => {
    const other = b[index]!
    return (
      session.id === other.id &&
      session.name === other.name &&
      session.visitedAt === other.visitedAt &&
      session.state.roster.terminals === other.state.roster.terminals
    )
  })

// The sidebar wired to the workspace: terminal tabs and workspace sessions.
export const SidebarSection = memo((): React.JSX.Element => {
  const { commands } = useWorkspaceServices()
  const {
    switchSession,
    startFresh,
    hideSidebar,
    add,
    reorder,
    reveal,
    dismissNotification,
    dismissAllNotifications,
  } = commands
  const desktop = useDesktop()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const workspaceSessions = useWorkspaceState(
    (workspace) => activeProject(workspace)!.history,
    sameSessions,
  )
  const target = useWorkspaceState(currentTarget, sameTarget)
  const ordered = useWorkspaceState(
    (workspace) => orderedTiles(currentState(workspace).roster),
    sameItems,
  )
  const notifications = useNotifications()
  // The terminal on screen, which is no news to the person while they look at it.
  const selected = useWorkspaceState(
    (workspace) => ({
      context: currentContext(workspace),
      id: currentState(workspace).selected,
    }),
    shallowEqual,
  )
  const sidebarPanel = useUiState((state) => state.location.route.panel)
  const visible = useUiState((state) => sidebarVisible(state.shell, desktop))
  return (
    <WorkspaceSidebar
      projectId={projectId}
      workspaceSessionId={target.workspaceSessionId}
      workspaceSessions={workspaceSessions}
      terminalCount={ordered.length}
      ordered={ordered}
      sidebarPanel={sidebarPanel}
      notifications={notifications}
      viewing={selected}
      sidebarVisible={visible}
      onSessionSelect={switchSession}
      onReveal={(notification) => reveal(notification.terminalId)}
      onDismissNotification={dismissNotification}
      onDismissAllNotifications={dismissAllNotifications}
      onFresh={startFresh}
      onHide={hideSidebar}
      onCreate={() => add()}
      renderTab={renderTab}
      onReorder={(tabOrder) => reorder(target, tabOrder)}
    />
  )
})
