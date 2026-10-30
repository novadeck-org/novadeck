import type { SourceListing, SourceProject } from "@novadeck/core/source"
import type { SidebarPanel as PanelId, Tile, WorkspaceSession } from "@novadeck/core/types"
import { Plus } from "lucide-react"
import type { ComponentProps } from "react"

import { HeldPill, InboxClear, InboxCount, InboxList, InboxMarkAll } from "../inbox/InboxList"
import { shortcutBindings } from "../interaction/shortcuts"
import { SessionsPanel } from "../sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { SourcePanel } from "../sidebar/SourcePanel"
import { TerminalTabs } from "../terminals/TerminalTabs"
import { panelLabels } from "./panels"

type Props = Omit<ComponentProps<typeof TerminalTabs>, "terminals"> & {
  projectId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  terminalCount: number
  ordered: readonly Tile[]
  sidebarPanel: PanelId
  sidebarVisible: boolean
  // Where the backend has a source: what its agents changed in the project, if it says, how to
  // read a folder, when an agent's turn last ended, how to open a file, the handle of the
  // selected terminal, and the session's agents for the strip: every terminal's handle in roster
  // order, and the teams as handles, each lead first. Left out, there is no Source panel.
  source:
    | {
        project: SourceProject | undefined
        list: (folder: string) => Promise<SourceListing>
        turn: number
        onOpenFile: (path: string) => Promise<void>
        selectedHandle: string | undefined
        roster: readonly string[]
        squads: readonly (readonly string[])[]
      }
    | undefined
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
  source,
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
    aria-label={panelLabels[sidebarPanel]}
    aria-hidden={!sidebarVisible}
    inert={!sidebarVisible}
  >
    {source && (
      <SourcePanel
        key={projectId}
        project={source.project}
        list={source.list}
        turn={source.turn}
        onOpenFile={source.onOpenFile}
        selectedHandle={source.selectedHandle}
        roster={source.roster}
        squads={source.squads}
        active={sidebarPanel === "source"}
        visible={sidebarVisible}
        onHide={onHide}
      />
    )}
    <SidebarPanel
      id="sessions-panel"
      title="Sessions"
      count={workspaceSessions.length}
      active={sidebarPanel === "sessions"}
      onClose={onHide}
    >
      <SessionsPanel
        key={projectId}
        sessions={workspaceSessions.map((session) => {
          const { terminals } = session.state.roster
          return {
            id: session.id,
            name: session.name,
            visitedAt: session.visitedAt,
            terminalNames: terminals.map((terminal) => terminal.name),
            running: terminals.filter((terminal) => terminal.state === "running").length,
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
      <button
        className={sidebarCreateClasses}
        aria-label="New terminal"
        data-terminals-create
        onClick={onCreate}
      >
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
      id="inbox-panel"
      title="Inbox"
      count={<InboxCount />}
      titleExtra={<HeldPill />}
      active={sidebarPanel === "inbox"}
      onClose={onHide}
      actions={
        <>
          <InboxClear />
          <InboxMarkAll />
        </>
      }
    >
      <InboxList />
    </SidebarPanel>
  </aside>
)
