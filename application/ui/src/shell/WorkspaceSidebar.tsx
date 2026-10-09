import { Plus } from "lucide-react"
import type { ComponentProps } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import type { SidebarPanel as PanelId, Tile, WorkspaceSession } from "../model/types"
import type { Notification } from "../notifications/notifications"
import { MarkAllReadButton, NotificationsPanel } from "../notifications/NotificationsPanel"
import { SessionsPanel } from "../sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { TerminalTabs } from "../terminals/TerminalTabs"
import type { Viewing } from "../terminals/unread-state"
import { panelLabels } from "./panels"

type Props = Omit<ComponentProps<typeof TerminalTabs>, "terminals"> & {
  projectId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  terminalCount: number
  ordered: readonly Tile[]
  sidebarPanel: PanelId
  // What asks for the person across the workspace, and the terminal they look at.
  notifications: readonly Notification[]
  viewing: Viewing
  sidebarVisible: boolean
  onSessionSelect: (id: string) => void
  onReveal: (notification: Notification) => void
  onDismissNotification: (notification: Notification) => void
  onDismissAllNotifications: (shown: readonly Notification[]) => void
  onFresh: () => void
  onHide: () => void
  onCreate: () => void
}
export const WorkspaceSidebar = ({
  projectId,
  workspaceSessionId,
  workspaceSessions,
  terminalCount,
  ordered,
  sidebarPanel,
  notifications,
  viewing,
  sidebarVisible,
  onSessionSelect,
  onReveal,
  onDismissNotification,
  onDismissAllNotifications,
  onFresh,
  onHide,
  onCreate,
  renderTab,
  onReorder,
}: Props): React.JSX.Element => (
  <aside
    id="terminal-sidebar"
    className="sidebar relative flex shrink-0 flex-col overflow-hidden"
    aria-label={panelLabels[sidebarPanel]}
    aria-hidden={!sidebarVisible}
    inert={!sidebarVisible}
  >
    <SidebarPanel
      id="sessions-panel"
      title="Sessions"
      count={workspaceSessions.length}
      active={sidebarPanel === "sessions"}
      onClose={onHide}
    >
      <SessionsPanel
        key={projectId}
        items={workspaceSessions.map((item) => {
          const itemTerminals = item.state.roster.terminals
          return {
            id: item.id,
            name: item.name,
            visitedAt: item.visitedAt,
            terminalNames: itemTerminals.map((entry) => entry.name),
            running: itemTerminals.filter((entry) => entry.state === "running").length,
          }
        })}
        activeId={workspaceSessionId}
        onSelect={onSessionSelect}
        onFresh={onFresh}
      />
    </SidebarPanel>
    <SidebarPanel
      id="terminals-panel"
      title="Terminals"
      titleHint={`Recent · ${shortcutBindings().recent.display.join(" ")}`}
      count={terminalCount}
      active={sidebarPanel === "terminals"}
      onClose={onHide}
    >
      <button className={sidebarCreateClasses} aria-label="New terminal" onClick={onCreate}>
        <Plus size={14} className="shrink-0" />
        <span className="min-w-0 truncate">Terminal</span>
        <kbd className="hint mb-[-2px] ml-auto shrink-0 whitespace-nowrap">
          {shortcutBindings().newTerminal.display.join(" ")}
        </kbd>
      </button>
      <TerminalTabs
        key={`${projectId}/${workspaceSessionId}`}
        terminals={ordered}
        renderTab={renderTab}
        onReorder={onReorder}
      />
    </SidebarPanel>
    <SidebarPanel
      id="notifications-panel"
      title="Notifications"
      count={notifications.length}
      active={sidebarPanel === "notifications"}
      onClose={onHide}
      actions={<MarkAllReadButton items={notifications} onDismissAll={onDismissAllNotifications} />}
    >
      <NotificationsPanel
        items={notifications}
        viewing={viewing}
        onReveal={onReveal}
        onDismiss={onDismissNotification}
      />
    </SidebarPanel>
  </aside>
)
