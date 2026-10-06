import { Plus } from "lucide-react"
import type { ComponentProps } from "react"

import { shortcutBindings } from "../interaction/shortcuts"
import type { Tile, WorkspaceSession } from "../model/types"
import { SessionsPanel } from "../sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { TerminalTabs } from "../terminals/TerminalTabs"

type Props = Omit<ComponentProps<typeof TerminalTabs>, "terminals"> & {
  projectId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  terminalCount: number
  ordered: readonly Tile[]
  sidebarPanel: "terminals" | "sessions"
  sidebarVisible: boolean
  onSessionSelect: (id: string) => void
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
  sidebarVisible,
  onSessionSelect,
  onFresh,
  onHide,
  onCreate,
  renderTab,
  onReorder,
}: Props): React.JSX.Element => (
  <aside
    id="terminal-sidebar"
    className="sidebar relative flex shrink-0 flex-col overflow-hidden"
    aria-label={sidebarPanel === "sessions" ? "Workspace sessions" : "Terminal sessions"}
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
  </aside>
)
