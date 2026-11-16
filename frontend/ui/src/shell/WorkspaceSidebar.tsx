import type { FolderListing, FilesProject } from "@novadeck/core/files"
import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"
import type { SidebarPanel as PanelId, Tile, WorkspaceSession } from "@novadeck/core/types"
import type { Work, WorkClosing } from "@novadeck/core/works"
import { Plus } from "lucide-react"
import type { ComponentProps } from "react"

import { HeldPill, InboxCount, InboxList } from "../inbox/InboxList"
import { shortcutBindings } from "../interaction/shortcuts"
import { sessionGlance, type SessionMark } from "../projects/session-marks"
import { FilesPanel } from "../sidebar/FilesPanel"
import { HistoryPanel } from "../sidebar/HistoryPanel"
import { panelLabels } from "../sidebar/panel-labels"
import { SessionsPanel, type SessionsMove } from "../sidebar/SessionsPanel"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { WorktreesPanel } from "../sidebar/WorktreesPanel"
import { programIcon } from "../terminals/processes/profiles"
import { TerminalTabs } from "../terminals/TerminalTabs"

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
  // Where the backend reads the projects' files: what its agents changed in the project, if it says, how to
  // read a folder, when an agent's turn last ended, how to follow the works the changes come
  // from while the panel shows, if they do, how to open a file, the handle of the selected
  // terminal, and the session's agents for the strip: every terminal's handle in roster order,
  // and the teams as handles, each lead first. Left out, there is no Files panel.
  files:
    | {
        project: FilesProject | undefined
        list: (folder: string) => Promise<FolderListing>
        turn: number
        watch: (() => () => void) | undefined
        onOpenFile: (path: string) => Promise<void>
        onLit?: ((lit: ReadonlySet<string>) => void) | undefined
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
  // Where the backend reports each tracked worktree's work against main: the open project's
  // works, the terminals' titles by id, the selected terminal, what a row's click does and what
  // its × does. Left out, there is no Worktrees panel.
  worktrees:
    | {
        works: readonly Work[]
        // The backend has reported every work at least once: until then no works isn't none.
        reported: boolean
        // Follows the works until the returned release is called.
        watch: () => () => void
        titles: ReadonlyMap<string, string>
        selectedId: string | undefined
        onSelect: (work: Work, on: string | undefined) => Promise<void>
        // Whether a file of a work can be opened so: it is in the open project.
        canOpenFile: (work: Work, path: string) => boolean
        // Opens a file of a work in the project window as a preview of what the works merge to.
        onOpenFile: (work: Work, path: string) => void
        onCloseWork: (root: string, force: boolean) => Promise<WorkClosing>
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
  files,
  history,
  worktrees,
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
    {files && (
      <FilesPanel
        key={projectId}
        project={files.project}
        list={files.list}
        turn={files.turn}
        watch={files.watch}
        onOpenFile={files.onOpenFile}
        onLit={files.onLit}
        selectedHandle={files.selectedHandle}
        roster={files.roster}
        squads={files.squads}
        active={sidebarPanel === "files"}
        visible={sidebarVisible}
        onHide={onHide}
      />
    )}
    <SidebarPanel
      id="sessions-panel"
      title={panelLabels.sessions}
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
      title={panelLabels.terminals}
      titleHint={`Recent · ${shortcutBindings().recent.display.join(" ")}`}
      count={terminalCount}
      // Which session's terminals these are, once the project has others to tell it from.
      scope={
        workspaceSessions.length > 1
          ? workspaceSessions.find((session) => session.id === workspaceSessionId)?.name
          : undefined
      }
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
    {worktrees && (
      <WorktreesPanel
        key="worktrees"
        {...worktrees}
        active={sidebarPanel === "worktrees"}
        watching={sidebarVisible && sidebarPanel === "worktrees"}
        onClose={onHide}
      />
    )}
    <SidebarPanel
      id="inbox-panel"
      title={panelLabels.inbox}
      count={<InboxCount />}
      titleExtra={<HeldPill />}
      active={sidebarPanel === "inbox"}
      onClose={onHide}
    >
      <InboxList />
    </SidebarPanel>
  </aside>
)
