import { allTeams, sameTeams } from "@novadeck/core/derivations"
import type { ClosedTerminal, HistoryState } from "@novadeck/core/history"
import { itemIdOf } from "@novadeck/core/items"
import { orderedIds } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { Work, WorksState } from "@novadeck/core/works"
import { memo, useCallback, useContext, useMemo, useSyncExternalStore } from "react"

import { useDesktop } from "../shell/desktop"
import { sidebarVisible } from "../shell/shell-state"
import { WorkspaceSidebar } from "../shell/WorkspaceSidebar"
import { filesOfWorks } from "../sidebar/files-works"
import type { WorktreesWire } from "../sidebar/WorktreesPanel"
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
import { FilesSection } from "./FilesSection"
import { historyShown, filesShown } from "./routing"
import { currentState, currentTarget, sameItems, sameTarget } from "./selectors"
import { SessionsSection } from "./SessionsSection"
import { toggleTeamFold, useReorderTiles } from "./team-fold"
import { useWorktreesShown } from "./use-worktrees-shown"
import { renderTab } from "./WorkspaceTab"
import { worktreesFoldContext, WorktreesWireContext } from "./worktrees-wire"

const sameHandles = (a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean =>
  a.size === b.size && [...a].every(([id, handle]) => b.get(id) === handle)

// What a backend without History reads in its place; its panel isn't drawn.
const noHistory = createStore<HistoryState>({ rows: [] })
const noAgents: readonly never[] = []
const noLeads: readonly string[] = []
const always = (): (() => void) => () => {}

const sameRows = (a: readonly ClosedTerminal[], b: readonly ClosedTerminal[]): boolean =>
  a.length === b.length && a.every((row, index) => Object.is(row, b[index]))

// The sidebar wired to the workspace: terminal tabs and workspace sessions.
export const SidebarSection = memo((): React.JSX.Element => {
  const { commands, backend, ui } = useWorkspaceServices()
  const { hideSidebar, add } = commands
  const reorderTiles = useReorderTiles()
  const desktop = useDesktop()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  // Only what the sidebar shows of the sessions itself: how many, and the open one's name
  // once there are others. Their rows read the rest (SessionsSection), and the tabs their own
  // tiles, so an agent's news wakes neither the sidebar nor its other panels.
  const sessionCount = useWorkspaceState((workspace) => activeProject(workspace)!.history.length)
  const sessionName = useWorkspaceState((workspace) => {
    const { history, activeSessionId } = activeProject(workspace)!
    return history.length > 1
      ? history.find((session) => session.id === activeSessionId)?.name
      : undefined
  })
  const target = useWorkspaceState(currentTarget, sameTarget)
  const ids = useWorkspaceState(
    (workspace) => orderedIds(currentState(workspace).roster),
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
  const checkout = useMemo(
    () =>
      filesFeed?.checkout && filesFeed.update
        ? {
            read: () => filesFeed.checkout!(projectId),
            update: () => filesFeed.update!(projectId),
          }
        : undefined,
    [filesFeed, projectId],
  )
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
  // the works are shown; any other as it is in main. Opening the file the window already previews
  // keeps what the person chose in it.
  const onOpenFile = useCallback(
    (path: string) =>
      commands.openProjectFile(path, {
        preview: worksFeed !== undefined && previewFiles(allWorks, projectId, path).length > 0,
        copy: copyOf(allWorks, projectId, path),
        keep: true,
      }),
    [commands, worksFeed, allWorks, projectId],
  )
  const onOpenFolder = useMemo(
    () => (backend.companions?.attach ? commands.openFolderInPane : undefined),
    [backend.companions, commands],
  )
  const onLit = useCallback(
    (lit: ReadonlySet<string>) =>
      ui.update((state) => (state.filesLit === lit ? state : { ...state, filesLit: lit })),
    [ui],
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
  // Handles of every project's terminals, bare, for the rows to say whose they are.
  const workHandles = useWorkspaceState(
    (workspace) =>
      new Map(
        workspace.projects.flatMap((project) =>
          project.history.flatMap((session) =>
            session.state.roster.terminals.flatMap((terminal) =>
              terminal.handle ? [[terminal.id, terminal.handle] as const] : [],
            ),
          ),
        ),
      ),
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
      revealTerminal(terminalId, projectId)
      const itemId = await worksFeed.show(work.root, terminalId)
      if (itemId !== null) openBarTab(terminalId, itemIdOf(itemId))
    },
    [worksFeed, revealTerminal, openBarTab, projectId],
  )
  // Its teams fold as the Terminals list's do, kept in the ui store by project; the team wire on
  // the rail (App's WorktreesWireSection) takes what the panel lends it.
  const foldContext = worktreesFoldContext(projectId)
  const foldedLeads = useUiState((state) => state.foldedTeams[foldContext] ?? noLeads)
  const foldPreview = useUiState((state) =>
    state.foldPreview?.context === foldContext ? state.foldPreview.lead : undefined,
  )
  const unfolding = useUiState((state) =>
    state.unfolding?.context === foldContext ? state.unfolding.lead : undefined,
  )
  const folding = useUiState((state) =>
    state.folding?.context === foldContext ? state.folding.lead : undefined,
  )
  const onFold = useCallback(
    (lead: string) => toggleTeamFold(ui, foldContext, lead),
    [ui, foldContext],
  )
  const wireStore = useContext(WorktreesWireContext)
  const onWire = useCallback(
    (wire: WorktreesWire | null, taken?: HTMLElement | null): void => {
      // A panel taking back its list leaves another's in place.
      wireStore?.update((current) =>
        wire !== null ? wire : current === null || current.list === taken ? null : current,
      )
    },
    [wireStore],
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
            onCloseWork: worksFeed.close,
            handles: workHandles,
            folded: foldedLeads,
            preview: foldPreview,
            unfolding,
            folding,
            onFold,
            onWire,
          }
        : undefined,
    [
      worksFeed,
      projectWorks,
      worksReported,
      titles,
      workHandles,
      selectedId,
      showWork,
      foldedLeads,
      foldPreview,
      unfolding,
      folding,
      onFold,
      onWire,
    ],
  )
  const sidebarPanel = useUiState((state) => state.location.route.panel)
  const visible = useUiState((state) => sidebarVisible(state.shell, desktop))
  return (
    <WorkspaceSidebar
      projectId={projectId}
      workspaceSessionId={target.workspaceSessionId}
      sessions={
        <SessionsSection
          key={projectId}
          workspaceSessionId={target.workspaceSessionId}
          historyKept={Boolean(history)}
        />
      }
      sessionCount={sessionCount}
      sessionName={sessionName}
      orderedIds={ids}
      sidebarPanel={sidebarPanel}
      sidebarVisible={visible}
      files={
        filesFeed && (
          <FilesSection
            key={projectId}
            project={filesProject ?? worksOverlay}
            list={list}
            checkout={checkout}
            watch={watchWorks}
            onOpenFile={onOpenFile}
            onOpenFolder={onOpenFolder}
            onLit={onLit}
            selectedHandle={selectedHandle}
            roster={roster}
            squads={squads}
            active={sidebarPanel === "files"}
            visible={visible}
            onHide={hideSidebar}
          />
        )
      }
      history={history}
      worktrees={worktrees}
      onHide={hideSidebar}
      onCreate={() => add()}
      renderTab={renderTab}
      onReorder={reorderTiles}
    />
  )
})
