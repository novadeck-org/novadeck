import { allTeams, leadChain, litTeams, sameLitTeams, sameTeams } from "@novadeck/core/derivations"
import { watchPerson } from "@novadeck/core/person"
import type { Backend, BackendSelection, CreateBackend, TerminalKey } from "@novadeck/core/port"
import { activeProject } from "@novadeck/core/state"
import { createStore } from "@novadeck/core/store"
import type { WorksMade } from "@novadeck/core/works"
import { failViewLoads } from "@novadeck/items/lazy-view"
import { guardFileDrops } from "@novadeck/toolkit/file-drops"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type ComponentType,
} from "react"
import { HashRouter, MemoryRouter } from "react-router"

import { sidebarToggle } from "../interaction/dom"
import { dictationKeys } from "../interaction/shortcuts"
import { cancelTerminalTransition } from "../layouts/transition"
import { elsewhereSessionsText } from "../projects/session-marks"
import { useDesktop } from "../shell/desktop"
import { HistoryDropNotice } from "../shell/HistoryDot"
import { sidebarVisible } from "../shell/shell-state"
import { readSidebarOrder, sidebarOrder, writeSidebarOrder } from "../shell/shell-storage"
import { SidebarRail } from "../shell/SidebarRail"
import { WorkspacePanels } from "../shell/WorkspacePanels"
import { ZenDock } from "../shell/ZenDock"
import { panelLabels } from "../sidebar/panel-labels"
import { createTabListStore, TabListContext, type TabListStore } from "../terminals/tab-list"
import { TeamWire } from "../terminals/TeamWire"
import { DictationOverlay } from "../voice/DictationOverlay"
import { BackendGate } from "./BackendGate"
import { BootReporter } from "./BootReporter"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { DictationContext, useDictationController } from "./controller/dictation"
import { useKeyboard } from "./controller/useKeyboard"
import { useStoreSelector } from "./controller/useStoreSelector"
import { useWorkspaceEffects } from "./controller/useWorkspaceEffects"
import { announceShown, EmbeddedContext, heldInput, holdInputUntilEngaged } from "./embedded"
import { FooterSection } from "./FooterSection"
import { HeaderSection } from "./HeaderSection"
import { dropWords } from "./history-drops"
import { InboxHost } from "./InboxHost"
import { MainSyncNotices } from "./MainSyncNotices"
import { MoveSessionsProvider } from "./move-to"
import { historyShown, filesShown } from "./routing"
import { currentContext, currentState, currentTarget, sameItems, shallowEqual } from "./selectors"
import { SidebarSection } from "./SidebarSection"
import { previewTeamFold, toggleTeamFold, useFoldedLeads } from "./team-fold"
import { TourRoot } from "./TourRoot"
import { useFilesNews } from "./use-files-news"
import { useWorktreesShown, useLeaveHiddenWorktrees } from "./use-worktrees-shown"
import { useInboxBadge } from "./useInboxBadge"
import { useSessionMarks } from "./useSessionMarks"
import { VisitorBar, VisitorCover } from "./Visitor"
import { WorkspaceOverlays } from "./WorkspaceOverlays"
import { WorkspaceProvider } from "./WorkspaceProvider"
import { WorkspaceStage } from "./WorkspaceStage"
import {
  createWorktreesWireStore,
  worktreesFoldContext,
  WorktreesWireContext,
  type WorktreesWireStore,
} from "./worktrees-wire"

/** A panel beside the workspace, as the content preview's debug panel is. */
export type WorkspacePanel = ComponentType<{
  // Adds a terminal to the current session and returns its key.
  readonly addTerminal: () => TerminalKey
  readonly startFresh: () => void
  readonly selected: () => TerminalKey | undefined
  // Brings a terminal of the session on screen into view selected, as its sidebar row does.
  readonly select: (key: TerminalKey) => void
  // Fails every pane view whose code loads lazily, as if it couldn't be fetched: each says so
  // in its pane, with a Retry.
  readonly failViewLoads: () => void
}>

export type AppProps = (
  | {
      // The backend its entry chose (see src/entries/), read once when the app mounts.
      readonly selection: BackendSelection
      readonly createBackend?: never
    }
  | {
      // A spec's backend, ready at once.
      readonly createBackend: CreateBackend
      readonly selection?: never
    }
) & {
  // True when another page frames the app (see app/embedded.ts). Its address then stays in
  // memory, so moving around the app adds nothing to the framing page's Back button.
  readonly embedded?: boolean
  // The panel the entry made with the backend it chose, where it made one.
  readonly panel?: ((backend: Backend) => WorkspacePanel | undefined) | undefined
}

export const App = ({
  selection,
  createBackend,
  embedded = false,
  panel,
}: AppProps): React.JSX.Element => {
  const Router = embedded ? MemoryRouter : HashRouter
  // Framed, the app tells the page around it once it is in view, once per page load:
  // StrictMode's second effect run, or a reboot, finds this set.
  const announced = useRef(false)
  const held = useRef(heldInput())
  const shown = (): void => {
    if (!embedded || announced.current) return
    announced.current = true
    announceShown()
  }
  // Framed, the wheel is the framing page's until the visitor engages the app there.
  useEffect(() => (embedded ? holdInputUntilEngaged(held.current) : undefined), [embedded])
  // Files dropped anywhere but on what takes them, as a terminal, do nothing: the page never
  // leaves for them, as a browser's would.
  useEffect(() => guardFileDrops(), [])
  return (
    <EmbeddedContext value={embedded}>
      <BackendGate
        onShown={shown}
        selection={selection ?? { createBackend }}
        render={(create, boot) => (
          <Router useTransitions={false}>
            <WorkspaceProvider createBackend={create}>
              <BootReporter report={boot} />
              <VisitorCover>
                <WorkspaceApp panel={panel} />
              </VisitorCover>
            </WorkspaceProvider>
          </Router>
        )}
      />
    </EmbeddedContext>
  )
}

// The panel the entry made with this backend, where it made one.
const PanelSection = ({ panel }: Pick<AppProps, "panel">): React.JSX.Element | null => {
  const { backend, commands, workspace } = useWorkspaceServices()
  const Panel = panel?.(backend)
  if (!Panel) return null
  return (
    // oxlint-disable-next-line react/static-components -- Made once with its backend, not here: the same panel each render.
    <Panel
      addTerminal={() => {
        const terminalId = commands.add()
        return { ...currentTarget(workspace.getSnapshot()), terminalId }
      }}
      startFresh={commands.startFresh}
      selected={() => {
        const snapshot = workspace.getSnapshot()
        const terminalId = currentState(snapshot).selected
        return terminalId ? { ...currentTarget(snapshot), terminalId } : undefined
      }}
      select={({ terminalId }) => commands.select(terminalId)}
      failViewLoads={failViewLoads}
    />
  )
}

// Hosts the effects that follow store changes; it renders nothing.
const WorkspaceEffects = (): null => {
  useWorkspaceEffects()
  return null
}

// Every team's wire on the rail's border, the selected terminal's lit, while the Terminals
// list shows. It reads the teams, the selection and its team itself, so a change to any of
// them re-renders only the wires.
const TeamWireSection = ({
  shown,
  tabList,
}: {
  shown: boolean
  tabList: TabListStore
}): React.JSX.Element => {
  const selected = useWorkspaceState((workspace) => currentState(workspace).selected)
  const teams = useWorkspaceState(allTeams, sameTeams)
  // What lights for the selection, its teams and the way up through the leads above it, and
  // each team's level, its lane (nested teams).
  const lit = useWorkspaceState((workspace) => litTeams(workspace, selected), sameLitTeams)
  const above = useWorkspaceState((workspace) => leadChain(workspace, selected), sameItems)
  const levels = useWorkspaceState(
    (workspace) => allTeams(workspace).map(({ lead }) => leadChain(workspace, lead).length),
    sameItems,
  )
  const chains = useWorkspaceState(
    (workspace) => allTeams(workspace).map(({ lead }) => leadChain(workspace, lead).join(" ")),
    sameItems,
  )
  const list = useSyncExternalStore(tabList.subscribe, tabList.getSnapshot)
  // Folding a lead's teammates out of the list, from the gutter beside its tab.
  const { ui } = useWorkspaceServices()
  const context = useWorkspaceState(currentContext)
  const folded = useFoldedLeads()
  const unfolding = useUiState((state) =>
    state.unfolding?.context === context ? state.unfolding.lead : undefined,
  )
  const onFold = useCallback((lead: string) => toggleTeamFold(ui, context, lead), [ui, context])
  const onPreview = useCallback(
    (lead: string | null) => previewTeamFold(ui, lead === null ? null : { context, lead }),
    [ui, context],
  )
  return (
    <TeamWire
      rowAttribute="data-terminal-tab-id"
      teams={teams}
      levels={levels}
      chains={chains}
      lit={lit}
      above={above}
      selected={selected}
      shown={shown}
      list={list}
      folded={folded}
      unfolding={unfolding}
      onFold={onFold}
      onPreview={onPreview}
    />
  )
}

// The Worktrees panel's teams on the rail's border, as the Terminals list's (TeamWireSection):
// a worktree heading to another open worktree's branch hangs under it, lit for the selected
// worktree's, folded from the gutter beside a lead. The panel lends its list and teams
// (worktrees-wire.ts); one list's wire shows at a time, as they share the list's scroll timeline.
const WorktreesWireSection = ({
  shown,
  store,
}: {
  shown: boolean
  store: WorktreesWireStore
}): React.JSX.Element | null => {
  const wire = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const { ui } = useWorkspaceServices()
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const context = worktreesFoldContext(projectId)
  const folded = useUiState((state) => state.foldedTeams[context] ?? noLeads)
  const unfolding = useUiState((state) =>
    state.unfolding?.context === context ? state.unfolding.lead : undefined,
  )
  const onFold = useCallback((lead: string) => toggleTeamFold(ui, context, lead), [ui, context])
  const onPreview = useCallback(
    (lead: string | null) => previewTeamFold(ui, lead === null ? null : { context, lead }),
    [ui, context],
  )
  if (!wire) return null
  return (
    <TeamWire
      rowAttribute="data-worktrees-row"
      kind="worktrees"
      teams={wire.teams}
      levels={wire.levels}
      chains={wire.chains}
      lit={wire.lit}
      above={wire.above}
      selected={wire.selected}
      shown={shown}
      list={wire.list}
      folded={folded}
      unfolding={unfolding}
      onFold={onFold}
      onPreview={onPreview}
    />
  )
}
const noLeads: readonly string[] = []

// What a backend without worktrees made: none.
const noneMade = createStore<WorksMade>(new Map())

// The rail and the Zen dock read the bell's badge and rings themselves, so an unread change that
// leaves them as they were re-renders neither them nor the app around them.
const RailWithBadge = (
  props: Omit<
    ComponentProps<typeof SidebarRail>,
    "badge" | "bellRings" | "historyDrops" | "lastDrop" | "sessionsAsk" | "worksMade" | "filesNews"
  >,
): React.JSX.Element => {
  const { backend } = useWorkspaceServices()
  const marks = useSessionMarks()
  const lastDrop = useUiState((state) => state.lastDrop)
  const openId = useWorkspaceState((workspace) => activeProject(workspace)!.activeSessionId)
  const projectId = useWorkspaceState((workspace) => workspace.activeProjectId)
  const madeIn = useCallback((counts: WorksMade) => counts.get(projectId) ?? 0, [projectId])
  const made = useStoreSelector(backend.works?.made ?? noneMade, madeIn)
  const worksMade = useMemo(() => ({ count: made, projectId }), [made, projectId])
  const filesNews = useFilesNews(
    backend,
    projectId,
    props.sidebarVisible && props.sidebarPanel === "files",
  )
  return (
    <SidebarRail
      {...props}
      badge={useInboxBadge()}
      bellRings={useUiState((state) => state.bellRings)}
      historyDrops={useUiState((state) => state.historyDrops)}
      lastDrop={lastDrop ? dropWords(lastDrop) : undefined}
      sessionsAsk={elsewhereSessionsText(marks, openId)}
      worksMade={worksMade}
      filesNews={filesNews}
    />
  )
}

// Tells a screen reader where a closed terminal went (HistoryDropNotice).
const HistoryDropSection = (): React.JSX.Element => (
  <HistoryDropNotice
    drops={useUiState((state) => state.historyDrops)}
    last={useUiState((state) => state.lastDrop?.title)}
  />
)

const ZenDockWithBadge = (
  props: Omit<ComponentProps<typeof ZenDock>, "badge" | "bellRings">,
): React.JSX.Element => (
  <ZenDock {...props} badge={useInboxBadge()} bellRings={useUiState((state) => state.bellRings)} />
)

export const WorkspaceApp = ({ panel }: Pick<AppProps, "panel"> = {}): React.JSX.Element => {
  const services = useWorkspaceServices()
  const { commands, canvas } = services
  const { hideSidebar, toggleSidebar, exitZen, changeView, add } = commands
  const desktop = useDesktop()
  const shell = useUiState((state) => {
    const { zen, sidebar, sidebarCollapsed } = state.shell
    return {
      zen: Boolean(zen),
      sidebar,
      sidebarCollapsed,
      sidebarVisible: sidebarVisible(state.shell, desktop),
      sidebarPanel: state.location.route.panel,
      sidebarBack: state.shell.sidebarBack,
      fontSize: state.preferences.fontSize,
      fontFamily: state.preferences.fontFamily ?? "",
      enabledViews: state.preferences.enabledViews,
    }
  }, shallowEqual)
  const { zen, sidebar, sidebarCollapsed, sidebarPanel, fontSize, fontFamily, enabledViews } = shell
  const view = useWorkspaceState((workspace) => currentState(workspace).view)
  // The Terminals list on screen, which the team wire draws beside.
  const [tabList] = useState(createTabListStore)
  // The Worktrees panel's list and teams, which their wire draws beside.
  const [worktreesWire] = useState(createWorktreesWireStore)
  const voice = useDictationController(services)
  useKeyboard(voice?.dictation)
  const { backend } = services
  // Where macOS's window buttons sit over the page, the rail and the sidebar run to the window's
  // top, as a Mac app's sidebar does, with the buttons on them, and the header heads the
  // terminals' column alone (shell/region.css). The side is the window's for its life.
  const [besideSidebar] = useState(() => backend.windowControls?.side === "start")
  const worktreesShown = useWorktreesShown()
  useLeaveHiddenWorktrees(worktreesShown)
  // The terminals' font follows Preferences.
  useEffect(() => {
    backend.setFont({ size: fontSize, ...(fontFamily && { family: fontFamily }) })
  }, [backend, fontSize, fontFamily])
  // The order the person left the rail's toggles in, kept for their next visit; one order
  // for both rails, the drawer's on a phone and the window's.
  // The person's, so it follows another device's change (core's person.ts).
  const [railOrder, setRailOrder] = useState(readSidebarOrder)
  useEffect(
    () =>
      watchPerson((key) => {
        if (key === sidebarOrder.key) setRailOrder(readSidebarOrder())
      }),
    [],
  )
  const sidebarRail = (mobile = false): React.JSX.Element => (
    <RailWithBadge
      mobile={mobile}
      sidebarVisible={shell.sidebarVisible}
      sidebarPanel={sidebarPanel}
      sidebarBack={shell.sidebarBack}
      zen={zen}
      hasFiles={filesShown(services.backend)}
      hasHistory={historyShown(services.backend)}
      hasWorktrees={worktreesShown}
      order={railOrder}
      onOrder={(order) => {
        setRailOrder(order)
        writeSidebarOrder(order)
      }}
      toggleSidebar={toggleSidebar}
    />
  )
  return (
    <DictationContext.Provider value={voice}>
      <TourRoot>
        <InboxHost active={sidebarPanel === "inbox" && shell.sidebarVisible}>
          <main
            className="workspace flex h-dvh min-h-100 flex-col overflow-hidden"
            data-zen={zen}
            onPointerDownCapture={cancelTerminalTransition}
            onKeyDownCapture={cancelTerminalTransition}
            style={
              {
                "--terminal-font-size": `${fontSize}px`,
              } as React.CSSProperties
            }
          >
            <WorkspaceEffects />
            {/* Windows' caption buttons' strip in Zen, where the header hides (shell/region.css). */}
            <div className="window-caption" aria-hidden="true" />
            <VisitorBar />
            {!besideSidebar && <HeaderSection />}
            <TabListContext.Provider value={tabList}>
              <WorktreesWireContext.Provider value={worktreesWire}>
                <MoveSessionsProvider>
                  <div
                    className="workspace-body relative flex min-h-0 flex-1"
                    data-titlebar={besideSidebar || undefined}
                    // Open only where the sidebar sits beside the rail: on a narrow screen it
                    // is a drawer over the page, and the header keeps clear of the buttons.
                    data-sidebar={desktop && !zen && !sidebarCollapsed ? "open" : "closed"}
                  >
                    {sidebarRail()}
                    {besideSidebar && <div className="rail-titlebar" aria-hidden="true" />}
                    <TeamWireSection
                      shown={
                        !zen &&
                        !sidebarCollapsed &&
                        shell.sidebarVisible &&
                        sidebarPanel === "terminals"
                      }
                      tabList={tabList}
                    />
                    <WorktreesWireSection
                      shown={
                        !zen &&
                        !sidebarCollapsed &&
                        shell.sidebarVisible &&
                        sidebarPanel === "worktrees"
                      }
                      store={worktreesWire}
                    />
                    <WorkspacePanels
                      collapsed={zen || sidebarCollapsed}
                      mobileOpen={!zen && sidebar}
                      onMobileOpenChange={(open) => {
                        if (!open) hideSidebar()
                      }}
                      mobileRail={sidebarRail(true)}
                      mobileLabel={panelLabels[sidebarPanel]}
                      mobileWide={sidebarPanel === "inbox"}
                      mobileFinalFocusEl={() => sidebarToggle(sidebarPanel)}
                      sidebar={<SidebarSection />}
                      titlebar={besideSidebar}
                    >
                      {besideSidebar ? (
                        <div className="workspace-column flex h-full min-h-0 min-w-0 flex-1 flex-col">
                          <HeaderSection />
                          <WorkspaceStage canvas={canvas} />
                        </div>
                      ) : (
                        <WorkspaceStage canvas={canvas} />
                      )}
                    </WorkspacePanels>
                    {zen && (
                      <ZenDockWithBadge
                        view={view}
                        enabledViews={enabledViews}
                        onCreate={() => add()}
                        onViewChange={(next) => {
                          if (next !== view) changeView(next)
                        }}
                        onInbox={() => toggleSidebar("inbox")}
                        onExit={exitZen}
                      />
                    )}
                  </div>
                </MoveSessionsProvider>
              </WorktreesWireContext.Provider>
            </TabListContext.Provider>
            <FooterSection />
            <WorkspaceOverlays />
            <HistoryDropSection />
            <MainSyncNotices />
            {voice && <DictationOverlay controller={voice} keys={dictationKeys()} />}
            <PanelSection panel={panel} />
          </main>
        </InboxHost>
      </TourRoot>
    </DictationContext.Provider>
  )
}
