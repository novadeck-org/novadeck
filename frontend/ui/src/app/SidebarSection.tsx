import { allTeams, sameTeams } from "@novadeck/core/derivations"
import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { orderedTiles } from "@novadeck/core/roster"
import type { SourceState } from "@novadeck/core/source"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceSession } from "@novadeck/core/types"
import { memo, useCallback, useMemo, useSyncExternalStore } from "react"

import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { latestTurnEnd } from "../sidebar/source-turns"
import { keepFoldsTogether } from "../terminals/team-fold"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { historyShown, sourceShown } from "./routing"
import { currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { foldsOf } from "./team-fold"
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
const noAgents: readonly never[] = []
const always = (): (() => void) => () => {}

const sameRows = (a: readonly ClosedTerminal[], b: readonly ClosedTerminal[]): boolean =>
  a.length === b.length && a.every((row, index) => Object.is(row, b[index]))

// The sidebar wired to the workspace: terminal tabs and workspace sessions.
export const SidebarSection = memo((): React.JSX.Element => {
  const { commands, backend, workspace: workspaceStore, ui } = useWorkspaceServices()
  const { switchSession, startFresh, hideSidebar, add, reorder } = commands
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
  const readHistory = useCallback(() => historyFeed!.list(projectId), [historyFeed, projectId])
  const history = useMemo(
    () =>
      historyFeed
        ? {
            rows: historyRows,
            list: readHistory,
            connections: backend.agents ? connections : undefined,
            onRestore: commands.restoreClosed,
            onReveal: commands.revealHandle,
            onConnect: commands.openAgentSettings,
          }
        : undefined,
    [historyFeed, historyRows, readHistory, backend.agents, connections, commands],
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
      sidebarVisible={visible}
      source={source}
      history={history}
      onSessionSelect={switchSession}
      onFresh={startFresh}
      onHide={hideSidebar}
      onCreate={() => add()}
      renderTab={renderTab}
      // A drag past a folded lead keeps its hidden team right after it, and says the order
      // saved, so the tabs follow it on screen.
      onReorder={(tabOrder) => {
        const saved = keepFoldsTogether(
          tabOrder,
          foldsOf(workspaceStore.getSnapshot(), ui.getSnapshot()),
        )
        reorder(target, saved)
        return saved
      }}
    />
  )
})
