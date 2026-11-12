import { allTeams, sameTeams } from "@novadeck/core/derivations"
import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { itemIdOf } from "@novadeck/core/items"
import { orderedTiles } from "@novadeck/core/roster"
import type { SourceState } from "@novadeck/core/source"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceSession } from "@novadeck/core/types"
import type { Work, WorksState } from "@novadeck/core/works"
import { memo, useCallback, useMemo, useSyncExternalStore } from "react"

import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { latestTurnEnd } from "../sidebar/source-turns"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { useMoving, useTabsAway } from "./move-to"
import { historyShown, sourceShown, worksShown } from "./routing"
import { currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { useReorderTiles } from "./team-fold"
import { useSessionMarks } from "./useSessionMarks"
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

const sameHandles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([id, handle]) => b.get(id) === handle)

// What a backend without a source reads in its place; its panel isn't drawn.
const noSource = createStore<SourceState>({ projects: {} })

// What a backend without History reads in its place; its panel isn't drawn.
const noHistory = createStore<HistoryState>({ rows: [] })
// What a backend without works reads in its place; its panel isn't drawn.
const noWorks = createStore<WorksState>({ works: [], synced: true })
// What a backend without the agent worktrees setting reads in its place.
const noWorktrees = createStore(false)
const noAgents: readonly never[] = []
const always = (): (() => void) => () => {}

const sameRows = (a: readonly ClosedTerminal[], b: readonly ClosedTerminal[]): boolean =>
  a.length === b.length && a.every((row, index) => Object.is(row, b[index]))

const sameWorks = (a: readonly Work[], b: readonly Work[]): boolean =>
  a.length === b.length && a.every((work, index) => Object.is(work, b[index]))

// The sidebar wired to the workspace: terminal tabs and workspace sessions.
export const SidebarSection = memo((): React.JSX.Element => {
  const { commands, backend } = useWorkspaceServices()
  const { switchSession, startFresh, hideSidebar, add } = commands
  const reorderTiles = useReorderTiles()
  const { renameSession, moveSession, removeSession } = commands
  const desktop = useDesktop()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const workspaceSessions = useWorkspaceState(
    (workspace) => activeProject(workspace)!.history,
    sameSessions,
  )
  const sessionMarks = useSessionMarks()
  const target = useWorkspaceState(currentTarget, sameTarget)
  const ordered = useWorkspaceState(
    (workspace) => orderedTiles(currentState(workspace).roster),
    sameItems,
  )
  // The Source panel shows where the backend has a source; see `sourceShown`.
  const sourceFeed = sourceShown(backend) ? backend.source : undefined
  const sourceProject = useStoreSelector(
    sourceFeed?.state ?? noSource,
    (state) => state.projects[projectId],
  )
  const list = useCallback(
    (folder: string) => sourceFeed!.list(projectId, folder),
    [sourceFeed, projectId],
  )
  // Its folders are read again when an agent's turn ends in the project.
  const turn = useWorkspaceState((workspace) => latestTurnEnd(activeProject(workspace)!))
  const selectedHandle = useWorkspaceState((workspace) => {
    const { roster, selected } = currentState(workspace)
    return roster.terminals.find((terminal) => terminal.id === selected)?.handle
  })
  // The agents strip's order and squads, by handle (a terminal with none has no agent here).
  const roster = useWorkspaceState(
    (workspace) =>
      currentState(workspace).roster.terminals.flatMap((terminal) =>
        terminal.handle ? [terminal.handle] : [],
      ),
    sameItems,
  )
  const teams = useWorkspaceState(allTeams, sameTeams)
  const handles = useWorkspaceState(
    (workspace) =>
      new Map(
        currentState(workspace).roster.terminals.flatMap((terminal) =>
          terminal.handle ? [[terminal.id, terminal.handle] as const] : [],
        ),
      ),
    sameHandles,
  )
  const squads = useMemo(
    () =>
      teams.map(({ lead, workers }) =>
        [lead, ...workers].flatMap((id) => (handles.has(id) ? [handles.get(id)!] : [])),
      ),
    [teams, handles],
  )
  const source = useMemo(
    () =>
      sourceFeed
        ? {
            project: sourceProject,
            list,
            turn,
            onOpenFile: commands.openSourceFile,
            selectedHandle,
            roster,
            squads,
          }
        : undefined,
    [sourceFeed, sourceProject, list, turn, commands, selectedHandle, roster, squads],
  )
  // The History panel shows where the backend keeps closed terminals; see `historyShown`.
  const historyFeed = historyShown(backend) ? backend.history : undefined
  const historyRows = useStoreSelector(
    historyFeed?.state ?? noHistory,
    (state) => state.rows.filter((row) => row.projectId === projectId),
    sameRows,
  )
  const connections = useSyncExternalStore(
    backend.agents?.state.subscribe ?? always,
    () => backend.agents?.state.getSnapshot() ?? noAgents,
  )
  // Reading the rows also looks at which agents are connected again: another window may
  // have connected one since, and the runner says nothing of it.
  const refreshAgents = backend.agents?.refresh
  const readHistory = useCallback(() => {
    refreshAgents?.()
    return historyFeed!.list(projectId)
  }, [historyFeed, projectId, refreshAgents])
  const history = useMemo(
    () =>
      historyFeed
        ? {
            rows: historyRows,
            list: readHistory,
            connections: backend.agents ? connections : undefined,
            onRestore: commands.restoreClosed,
            onReveal: (terminalId: string) => commands.revealTerminal(terminalId, projectId),
            onConnect: commands.openAgentSettings,
          }
        : undefined,
    [historyFeed, historyRows, readHistory, backend.agents, connections, commands, projectId],
  )
  const moving = useMoving()
  const away = useTabsAway()
  // The Changes panel shows where the backend reports the terminals' work; see `worksShown`.
  const worksFeed = worksShown(backend) ? backend.works : undefined
  const projectWorks = useStoreSelector(
    worksFeed?.state ?? noWorks,
    (state) => state.works.filter((work) => work.projectId === projectId),
    sameWorks,
  )
  const worksSynced = useStoreSelector(worksFeed?.state ?? noWorks, (state) => state.synced)
  // Titles of the project's terminals, in every session of it, for the rows to name.
  const titles = useWorkspaceState(
    (workspace) =>
      new Map(
        activeProject(workspace)!.history.flatMap((session) =>
          session.state.roster.terminals.map((terminal) => [terminal.id, terminal.name] as const),
        ),
      ),
    sameHandles,
  )
  const selectedId = useWorkspaceState((workspace) => currentState(workspace).selected)
  const { revealTerminal, openBarTab } = commands
  // A work is shown on its owner's bar, or, with no owner, on the selected terminal's.
  const showWork = useCallback(
    (work: Work) => {
      if (!worksFeed) return
      const terminalId = work.terminalId ?? selectedId
      if (terminalId !== undefined) {
        revealTerminal(terminalId, projectId)
        worksFeed.show(work.root, terminalId).then(
          (itemId) => {
            if (itemId !== null) openBarTab(terminalId, itemIdOf(itemId))
          },
          () => {},
        )
      }
      worksFeed.look(work.root)
    },
    [worksFeed, revealTerminal, openBarTab, projectId, selectedId],
  )
  const worktreesOn = useStoreSelector(backend.worktrees?.enabled ?? noWorktrees, (on) => on)
  const agentWorktrees: "on" | "off" | "absent" = backend.worktrees
    ? worktreesOn
      ? "on"
      : "off"
    : "absent"
  const changes = useMemo(
    () =>
      worksFeed
        ? {
            works: projectWorks,
            synced: worksSynced,
            watch: worksFeed.watch,
            titles,
            selectedId,
            agentWorktrees,
            onSelect: showWork,
            onCloseWork: worksFeed.close,
          }
        : undefined,
    [worksFeed, projectWorks, worksSynced, titles, selectedId, agentWorktrees, showWork],
  )
  const sidebarPanel = useUiState((state) => state.location.route.panel)
  const visible = useUiState((state) => sidebarVisible(state.shell, desktop))
  return (
    <WorkspaceSidebar
      projectId={projectId}
      workspaceSessionId={target.workspaceSessionId}
      workspaceSessions={workspaceSessions}
      sessionMarks={sessionMarks}
      terminalCount={ordered.length}
      ordered={ordered}
      sidebarPanel={sidebarPanel}
      sidebarVisible={visible}
      source={source}
      history={history}
      changes={changes}
      onSessionSelect={switchSession}
      onSessionRename={renameSession}
      onSessionMove={moveSession}
      onSessionRemove={removeSession}
      onFresh={startFresh}
      onHide={hideSidebar}
      onCreate={() => add()}
      renderTab={renderTab}
      onReorder={reorderTiles}
      moving={moving}
      away={away}
    />
  )
})
