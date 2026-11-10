import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"
import type { SourceListing, SourceProject } from "@novadeck/core/source"
import type { SidebarPanel as PanelId, Tile, WorkspaceSession } from "@novadeck/core/types"
import { Plus } from "lucide-react"
import type { ComponentProps } from "react"

import { HeldPill, InboxClear, InboxCount, InboxList, InboxMarkAll } from "../inbox/InboxList"
import { shortcutBindings } from "../interaction/shortcuts"
import { sessionGlance, type SessionMark } from "../projects/session-marks"
import { HistoryPanel } from "../sidebar/HistoryPanel"
import { SessionsPanel, type SessionsMove } from "../sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { SourcePanel } from "../sidebar/SourcePanel"
import { programIcon } from "../terminals/processes/profiles"
import { TerminalTabs } from "../terminals/TerminalTabs"
import { panelLabels } from "./panels"

type Props = Omit<ComponentProps<typeof TerminalTabs>, "terminals"> & {
  projectId: string
  workspaceSessionId: string
  workspaceSessions: WorkspaceSession[]
  // What each session's terminals show at a glance, by its id.
  sessionMarks: Readonly<Record<string, SessionMark>>
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
  // Where the backend keeps closed terminals: this project's rows, how to read them afresh
  // (stable, as it starts a read), the agents it can connect, and what a row's click does.
  // Left out, there is no History panel.
  history:
    | {
        rows: readonly ClosedTerminal[]
        list: () => Promise<unknown>
        connections: readonly AgentConnection[] | undefined
        onRestore: (row: ClosedTerminal) => void
        onReveal: (terminalId: string) => void
        onConnect: (agent: AgentName) => void
      }
    | undefined
  onSessionSelect: (id: string) => void
  onSessionRename: (id: string, name: string) => void
  onSessionMove: (id: string, index: number) => void
  // A terminal on its way to another session, while the person picks where.
  moving?: SessionsMove | undefined
  onSessionRemove: (id: string) => void
  onFresh: () => void
  onHide: () => void
  onCreate: () => void
}
// A closed terminal's icon: its agent's, or its last program's, or a plain terminal's.
const historyIcon = (row: ClosedTerminal): React.JSX.Element => {
  const Icon = programIcon(row.agent ?? row.program ?? "")
  return <Icon size={14} strokeWidth={1.5} />
}

export const WorkspaceSidebar = ({
  projectId,
  workspaceSessionId,
  workspaceSessions,
  sessionMarks,
  terminalCount,
  ordered,
  sidebarPanel,
  sidebarVisible,
  source,
  history,
  onSessionSelect,
  onSessionRename,
  onSessionMove,
  onSessionRemove,
  onFresh,
  onHide,
  onCreate,
  renderTab,
  onReorder,
  moving,
  away,
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
            mark: sessionGlance(sessionMarks[session.id]),
          }
        })}
        activeId={workspaceSessionId}
        onSelect={onSessionSelect}
        onFresh={onFresh}
        onRename={onSessionRename}
        onMove={onSessionMove}
        onRemove={onSessionRemove}
        historyKept={Boolean(history)}
        moving={moving}
        onScreen={sidebarVisible && sidebarPanel === "sessions"}
      />
    </SidebarPanel>
    {history && (
      <HistoryPanel
        key={`history/${projectId}`}
        {...history}
        iconOf={historyIcon}
        active={sidebarPanel === "history"}
        onClose={onHide}
      />
    )}
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
        away={away}
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
