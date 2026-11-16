import { allTeams, sameTeams } from "@novadeck/core/derivations"
import type { ForgeConnection } from "@novadeck/core/forges"
import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { itemIdOf } from "@novadeck/core/items"
import { orderedTiles } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import { handleText } from "@novadeck/core/terminals/handle"
import type { WorkspaceSession } from "@novadeck/core/types"
import type { Work, WorksState } from "@novadeck/core/works"
import { memo, useCallback, useMemo, useSyncExternalStore } from "react"

import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { latestTurnEnd } from "../sidebar/files-turns"
import { projectPath, filesOfWorks } from "../sidebar/files-works"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useStoreSelector } from "./controller/useStoreSelector"
import {
  copyOf,
  noFiles,
  noWorks,
  ownersOf,
  previewFiles,
  sameOwners,
  sameWorks,
} from "./files-feed"
import { useMoving, useTabsAway } from "./move-to"
import { historyShown, filesShown } from "./routing"
import { currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { useReorderTiles } from "./team-fold"
import { useWorktreesShown } from "./use-worktrees-shown"
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

// What a backend without forges reads in their place.
const noForges = createStore<readonly ForgeConnection[]>([])

const sameHandles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([id, handle]) => b.get(id) === handle)

// What a backend without History reads in its place; its panel isn't drawn.
const noHistory = createStore<HistoryState>({ rows: [] })
const noAgents: readonly never[] = []
const always = (): (() => void) => () => {}

const sameRows = (a: readonly ClosedTerminal[], b: readonly ClosedTerminal[]): boolean =>
  a.length === b.length && a.every((row, index) => Object.is(row, b[index]))

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
  // The Files panel shows where the backend reads the projects' files; see `filesShown`.
  const filesFeed = filesShown(backend) ? backend.files : undefined
  const filesProject = useStoreSelector(
    filesFeed?.state ?? noFiles,
    (state) => state.projects[projectId],
  )
  const list = useCallback(
    (folder: string) => filesFeed!.list(projectId, folder),
    [filesFeed, projectId],
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
  // The Worktrees panel shows where the backend reports the terminals' work, while agent
  // worktrees are on; see `useWorktreesShown`.
  const worksFeed = useWorktreesShown() ? backend.works : undefined
  // Every project's works, for the Files panel and previews to pick the open project's from.
  const allWorks = useStoreSelector(worksFeed?.state ?? noWorks, (state) => state.works, sameWorks)
  // The open project's works: the Worktrees panel lists only these.
  const ofProject = useCallback(
    (state: WorksState) => state.works.filter((work) => work.projectId === projectId),
    [projectId],
  )
  const projectWorks = useStoreSelector(worksFeed?.state ?? noWorks, ofProject, sameWorks)
  // The terminals of every session of the project that may own its worktrees, by id.
  const owners = useWorkspaceState(
    (workspace) => ownersOf(activeProject(workspace)!.history),
    sameOwners,
  )
  // Where the backend tells no changes of its own, the Files panel lays the project's works
  // over its files while the Worktrees panel shows, and follows them while it shows.
  const worksOverlay = useMemo(
    () => (worksFeed && !filesProject ? filesOfWorks(allWorks, projectId, owners) : undefined),
    [worksFeed, filesProject, allWorks, projectId, owners],
  )
  const watchWorks = filesProject ? undefined : worksFeed?.watch
  // A file some work of the project changes opens as a preview of what the works merge to, while
  // the works are shown; any other as it is in main.
  const onOpenFile = useCallback(
    (path: string) =>
      commands.openProjectFile(path, {
        preview: worksFeed !== undefined && previewFiles(allWorks, projectId, path).length > 0,
        copy: copyOf(allWorks, projectId, path),
      }),
    [commands, worksFeed, allWorks, projectId],
  )
  const onLit = useCallback(
    (lit: ReadonlySet<string>) =>
      ui.update((state) => (state.filesLit === lit ? state : { ...state, filesLit: lit })),
    [ui],
  )
  const files = useMemo(
    () =>
      filesFeed
        ? {
            project: filesProject ?? worksOverlay,
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
      filesFeed,
      filesProject,
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
  // Handles of every project's terminals, as people see them, for the rows to say whose they are.
  const workHandles = useWorkspaceState(
    (workspace) =>
      new Map(
        workspace.projects.flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.flatMap((terminal) =>
              terminal.handle ? [[terminal.id, handleText(terminal.handle)] as const] : [],
            ),
          ),
        ),
      ),
    sameHandles,
  )
  // Whether pull requests are looked for: a forge is on and its tool installed. A backend without
  // forges (a demo's)
  // has its works say so themselves.
  const forgesOn = useStoreSelector(backend.forges?.state ?? noForges, (forges) =>
    backend.forges ? forges.some((forge) => forge.enabled && forge.available) : true,
  )
  const fetchOrigin = useMemo(
    () => (worksFeed?.fetch ? () => worksFeed.fetch!(projectId) : undefined),
    [worksFeed, projectId],
  )
  const selectedId = useWorkspaceState((workspace) => currentState(workspace).selected)
  const { revealTerminal, openBarTab } = commands
  // A work is shown on the bar of the terminal the panel names (its owner's, or the selected
  // terminal's where it has none or its owner is closed). A failure reaches the panel.
  const showWork = useCallback(
    async (work: Work, terminalId: string | undefined): Promise<void> => {
      if (!worksFeed) return
      if (terminalId === undefined) return
      revealTerminal(terminalId, projectId)
      const itemId = await worksFeed.show(work.root, terminalId)
      if (itemId !== null) openBarTab(terminalId, itemIdOf(itemId))
    },
    [worksFeed, revealTerminal, openBarTab, projectId],
  )
  // A file of a work, opened in the project window as a preview: only a file that main has (the
  // window shows main's checkout, which it can only point at).
  const inOpenProject = useCallback(
    (work: Work, path: string): string | undefined =>
      work.folder === undefined ? undefined : projectPath(work.folder, path),
    [],
  )
  const canOpenWorkFile = useCallback(
    (work: Work, path: string): boolean => inOpenProject(work, path) !== undefined,
    [inOpenProject],
  )
  const openWorkFile = useCallback(
    (work: Work, path: string): void => {
      const inProject = inOpenProject(work, path)
      if (inProject !== undefined)
        commands
          .openProjectFile(inProject, {
            preview: true,
            copy: copyOf(allWorks, projectId, inProject),
          })
          .catch(() => {})
    },
    [commands, inOpenProject, allWorks, projectId],
  )
  const worktrees = useMemo(
    () =>
      worksFeed
        ? {
            works: projectWorks,
            reported: worksReported,
            watch: worksFeed.watch,
            titles,
            selectedId,
            onSelect: showWork,
            canOpenFile: canOpenWorkFile,
            onOpenFile: openWorkFile,
            onCloseWork: worksFeed.close,
            handles: workHandles,
            forges: forgesOn,
            ...(fetchOrigin ? { onFetch: fetchOrigin } : {}),
          }
        : undefined,
    [
      worksFeed,
      projectWorks,
      worksReported,
      titles,
      workHandles,
      forgesOn,
      fetchOrigin,
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
      files={files}
      history={history}
      worktrees={worktrees}
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
