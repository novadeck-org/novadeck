import { allTeams, sameTeams } from "@novadeck/core/derivations"
import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { itemIdOf } from "@novadeck/core/items"
import { orderedTiles } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { WorkspaceSession } from "@novadeck/core/types"
import type { Work } from "@novadeck/core/works"
import { memo, useCallback, useMemo, useSyncExternalStore } from "react"

import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { latestTurnEnd } from "../sidebar/source-turns"
import { projectPath, sourceOfWorks } from "../sidebar/source-works"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import { useMoving, useTabsAway } from "./move-to"
import { historyShown, sourceShown } from "./routing"
import { currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { noSource, noWorks, ownersOf, sameOwners, sameWorks } from "./source-feed"
import { useReorderTiles } from "./team-fold"
import { useChangesShown } from "./use-changes-shown"
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

// What a backend without History reads in its place; its panel isn't drawn.
const noHistory = createStore<HistoryState>({ rows: [] })
const noAgents: readonly never[] = []
const always = (): (() => void) => () => {}

const sameRows = (a: readonly ClosedTerminal[], b: readonly ClosedTerminal[]): boolean =>
  a.length === b.length && a.every((row, index) => Object.is(row, b[index]))

// Whether a work of the project changes the file at `path`, from the project's folder.
const touchedBy = (works: readonly Work[], projectId: string, path: string): boolean =>
  works.some(
    ({ projectId: own, folder, files }) =>
      own === projectId &&
      folder !== undefined &&
      files.some((file) => projectPath(folder, file.path) === path),
  )

// The sidebar wired to the workspace: terminal tabs and workspace sessions.
export const SidebarSection = memo((): React.JSX.Element => {
  const { commands, backend, ui } = useWorkspaceServices()
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
  // The Changes panel shows where the backend reports the terminals' work, while agent
  // worktrees are on; see `useChangesShown`.
  const worksFeed = useChangesShown() ? backend.works : undefined
  // Every project's works: the panel lists them all, naming each row's project.
  const allWorks = useStoreSelector(worksFeed?.state ?? noWorks, (state) => state.works, sameWorks)
  // The terminals of every session of the project that may own its worktrees, by id.
  const owners = useWorkspaceState(
    (workspace) => ownersOf(activeProject(workspace)!.history),
    sameOwners,
  )
  // Where the backend tells no changes of its own, the Source panel lays the project's works
  // over its files while the Changes panel shows, and follows them while it shows.
  const worksOverlay = useMemo(
    () => (worksFeed && !sourceProject ? sourceOfWorks(allWorks, projectId, owners) : undefined),
    [worksFeed, sourceProject, allWorks, projectId, owners],
  )
  const watchWorks = sourceProject ? undefined : worksFeed?.watch
  // A file some work of the project changes opens as a preview of what the works merge to, while
  // the works are shown; any other as it is in main.
  const onOpenFile = useCallback(
    (path: string) =>
      commands.openSourceFile(path, {
        preview: worksFeed !== undefined && touchedBy(allWorks, projectId, path),
      }),
    [commands, worksFeed, allWorks, projectId],
  )
  const onLit = useCallback(
    (lit: ReadonlySet<string>) =>
      ui.update((state) => (state.sourceLit === lit ? state : { ...state, sourceLit: lit })),
    [ui],
  )
  const source = useMemo(
    () =>
      sourceFeed
        ? {
            project: sourceProject ?? worksOverlay,
            list,
            turn,
            watch: watchWorks,
            onOpenFile,
            onLit,
            selectedHandle,
            roster,
            squads,
          }
        : undefined,
    [
      sourceFeed,
      sourceProject,
      worksOverlay,
      list,
      turn,
      watchWorks,
      onOpenFile,
      onLit,
      selectedHandle,
      roster,
      squads,
    ],
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
  const worksReported = useStoreSelector(worksFeed?.state ?? noWorks, (state) => state.reported)
  // Titles of every project's terminals, in every session of it, for the rows to name.
  const titles = useWorkspaceState(
    (workspace) =>
      new Map(
        workspace.projects.flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.map((terminal) => [terminal.id, terminal.name] as const),
          ),
        ),
      ),
    sameHandles,
  )
  const projectNames = useWorkspaceState(
    (workspace) =>
      new Map(workspace.projects.map((project) => [project.id, project.name] as const)),
    sameHandles,
  )
  const selectedId = useWorkspaceState((workspace) => currentState(workspace).selected)
  const { revealTerminal, openBarTab } = commands
  // A work is shown on the bar of the terminal the panel names (its owner's, or the selected
  // terminal's where it has none or its owner is closed). A failure reaches the panel.
  const showWork = useCallback(
    async (work: Work, terminalId: string | undefined): Promise<void> => {
      if (!worksFeed) return
      if (terminalId === undefined) return
      // The owner may be in another project; any other terminal is the selected one's.
      revealTerminal(terminalId, terminalId === work.terminalId ? work.projectId : projectId)
      const itemId = await worksFeed.show(work.root, terminalId)
      if (itemId !== null) openBarTab(terminalId, itemIdOf(itemId))
    },
    [worksFeed, revealTerminal, openBarTab, projectId],
  )
  // A file of a work, opened in the project window as a preview: only a file of the open project
  // that main has (the window shows main's checkout, which it can only point at).
  const inOpenProject = useCallback(
    (work: Work, path: string): string | undefined =>
      work.folder === undefined || work.projectId !== projectId
        ? undefined
        : projectPath(work.folder, path),
    [projectId],
  )
  const canOpenWorkFile = useCallback(
    (work: Work, path: string): boolean => inOpenProject(work, path) !== undefined,
    [inOpenProject],
  )
  const openWorkFile = useCallback(
    (work: Work, path: string): void => {
      const inProject = inOpenProject(work, path)
      if (inProject !== undefined)
        commands.openSourceFile(inProject, { preview: true }).catch(() => {})
    },
    [commands, inOpenProject],
  )
  const changes = useMemo(
    () =>
      worksFeed
        ? {
            works: allWorks,
            reported: worksReported,
            watch: worksFeed.watch,
            titles,
            projects: projectNames,
            selectedId,
            onSelect: showWork,
            canOpenFile: canOpenWorkFile,
            onOpenFile: openWorkFile,
            onCloseWork: worksFeed.close,
          }
        : undefined,
    [
      worksFeed,
      allWorks,
      worksReported,
      titles,
      projectNames,
      selectedId,
      showWork,
      canOpenWorkFile,
      openWorkFile,
    ],
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
