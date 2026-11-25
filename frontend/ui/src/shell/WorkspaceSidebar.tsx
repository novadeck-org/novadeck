import type { AgentName } from "@novadeck/core/harnesses"
import type { ClosedTerminal } from "@novadeck/core/history"
import type { AgentConnection } from "@novadeck/core/port"
import type { SidebarPanel as PanelId } from "@novadeck/core/types"
import type { Work, WorkClosing } from "@novadeck/core/works"
import { Plus } from "lucide-react"
import type { ComponentProps, ReactNode } from "react"

import { HeldPill, InboxCount, InboxList } from "../inbox/InboxList"
import { shortcutBindings } from "../interaction/shortcuts"
import { HistoryPanel } from "../sidebar/HistoryPanel"
import { panelLabels } from "../sidebar/panel-labels"
import { SidebarPanel, sidebarCreateClasses } from "../sidebar/SidebarPanel"
import { WorktreesPanel, type WorktreesWire } from "../sidebar/WorktreesPanel"
import { programIcon } from "../terminals/processes/profiles"
import { TerminalTabs } from "../terminals/TerminalTabs"

type Props = Omit<ComponentProps<typeof TerminalTabs>, "ids"> & {
  projectId: string
  workspaceSessionId: string
  // The Sessions panel's list, which reads the sessions itself, how many there are, and the
  // open one's name once the project has others to tell it from.
  sessions: ReactNode
  sessionCount: number
  sessionName: string | undefined
  // The tiles' ids in sidebar order: each tab reads its own tile.
  orderedIds: readonly string[]
  sidebarPanel: PanelId
  sidebarVisible: boolean
  // The Files panel, wired to where the backend reads the projects' files (FilesSection); left
  // out, there is none.
  files: ReactNode
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
        onCloseWork: (root: string, force: boolean) => Promise<WorkClosing>
        // Each terminal's handle, bare, by id, where it has one.
        handles?: ReadonlyMap<string, string>
        // Its folded teams and the team wire's share (WorktreesPanel's own props).
        folded?: readonly string[]
        preview?: string | undefined
        unfolding?: string | undefined
        folding?: string | undefined
        onFold?: (lead: string) => void
        onWire?: (wire: WorktreesWire | null, list?: HTMLElement | null) => void
      }
    | undefined
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
  sessions,
  sessionCount,
  sessionName,
  orderedIds,
  sidebarPanel,
  sidebarVisible,
  files,
  history,
  worktrees,
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
    {files}
    <SidebarPanel
      id="sessions-panel"
      title={panelLabels.sessions}
      count={sessionCount}
      active={sidebarPanel === "sessions"}
      onClose={onHide}
    >
      {sessions}
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
      count={orderedIds.length}
      // Which session's terminals these are, once the project has others to tell it from.
      scope={sessionName}
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
        ids={orderedIds}
        renderTab={renderTab}
        onReorder={onReorder}
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
