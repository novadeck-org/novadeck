import { createChat, watchChat } from "@novadeck/chat/state"
import { readChatOfferAnswered } from "@novadeck/core/agents/chat-offer"
import type { CreateBackend } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore } from "@novadeck/core/store"
import { createDragSession, DragSessionContext } from "@novadeck/items/drag-session"
import { followMessages } from "@novadeck/items/messages"
import { PullRequestsContext } from "@novadeck/items/pull-requests"
import { createItemStore } from "@novadeck/items/store"
import { createRef, useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocation, useNavigate, useNavigationType, type Location } from "react-router"

import type { CanvasHandle } from "../layouts/canvas/types"
import { readPreferences } from "../preferences/preferences-storage"
import { listedArrangement } from "../projects/project-arrangement"
import { readStoredProjectArrangement } from "../projects/project-arrangement-storage"
import { readSidebarCollapsed, readWindowedView } from "../shell/shell-storage"
import { readFoldedTeams } from "../terminals/team-fold"
import { createTeamNews, TeamNewsContext } from "../terminals/team-news"
import { watchActiveTerminal } from "./active-terminal"
import { followSavedPreferences, watchAppearance } from "./appearance"
import { createNavigator, type NavigatorServices, type RouterBinding } from "./commands/navigator"
import { createWorkspaceCommands } from "./commands/workspace"
import { connectBackend } from "./controller/backend-connection"
import { WorkspaceServicesContext, type WorkspaceServices } from "./controller/context"
import { domEffects } from "./controller/effects"
import { dialogDepthOf, useRouteSync } from "./controller/useRouteSync"
import { dingOf } from "./ding"
import { watchHistoryDrops } from "./history-drops"
import { landInbox, noLanding } from "./inbox-landing"
import { noticeBoard, watchBellRings, watchInboxPings } from "./inbox-pings"
import { nameFinished, watchFinishes } from "./murmur-offer"
import { watchPageFocus } from "./page-focus"
import { watchProjectWindows, watchWindowTitle } from "./project-windows"
import { pullRequestsOf } from "./pull-requests"
import { availablePanels, historyShown, resolveRoute, filesShown, reportsWorks } from "./routing"
import { watchScale } from "./scale"
import { currentContext } from "./selectors"
import {
  createUiStore,
  initialUi,
  persistUi,
  trackRecent,
  watchPresentation,
  watchClosing,
  watchMoving,
  watchCrashLoop,
  keepProjectArrangement,
  watchSwitcher,
  watchPortable,
  watchSandbox,
  watchUpdates,
  watchExperimental,
  watchWhatsNew,
  type UiLocation,
} from "./ui-store"
import { watchUnreadTurns } from "./unread-turns"
import { watchWindowControls } from "./window-controls"

const now = (): number => Date.now()

// Pure apart from the backend factory: StrictMode may call it twice and discard one
// result, whose backend is never started.
const createServices = (
  createBackend: CreateBackend,
  location: Location,
  navigationType: UiLocation["navigationType"],
): { services: WorkspaceServices; sync: NavigatorServices & RouterBinding } => {
  const backend = createBackend()
  const preferences = readPreferences()
  const view = preferences.enabledViews.includes("focus") ? "focus" : preferences.enabledViews[0]!
  const seeded = workspaceFromSeed(backend.seed, {
    view,
    windowedView: readWindowedView(),
    now: now(),
  })
  const panels = availablePanels(filesShown(backend), historyShown(backend), reportsWorks(backend))
  const { workspace: initial, route } = resolveRoute(seeded, location, preferences, now(), panels)
  const workspace = createWorkspaceStore(initial, backend.commit)
  // The store only reports later commits; give the backend the starting terminals now.
  backend.commit(initial, [])
  // Terminals mount in layout effects, before any effect of the app's could tell the font.
  backend.setFont({
    size: preferences.fontSize,
    ...(preferences.fontFamily && { family: preferences.fontFamily }),
  })
  const ui = createUiStore(
    initialUi({
      location: { route, dialogDepth: dialogDepthOf(location.state), navigationType },
      preferences,
      sidebarCollapsed: readSidebarCollapsed(),
      chatOfferAnswered: readChatOfferAnswered(),
      // What the person arranged before the runner kept it wins until it has been sent.
      projectArrangement:
        (backend.arrange && readStoredProjectArrangement()) ||
        listedArrangement(backend.seed.projects),
      foldedTeams: readFoldedTeams(),
      extraWindow: backend.projectWindows?.extra === true,
    }),
  )
  const chat = createChat()
  const { bind, settle, ...navigation } = createNavigator({ workspace, ui, now, panels })
  const canvas = createRef<CanvasHandle>()
  const itemStore =
    backend.companions && createItemStore({ companions: backend.companions, workspace })
  const landing = backend.inbox ? landInbox(backend.inbox, workspace, ui) : noLanding
  const commands = createWorkspaceCommands({
    workspace,
    ui,
    chat,
    navigation,
    newTerminal: backend.newTerminal,
    pickDirectory: backend.pickDirectory,
    crashLoop: backend.crashLoop,
    resetTitle: backend.resetTitle,
    moveTerminal: backend.moveTerminal,
    murmur: backend.murmur,
    conversations: backend.conversations,
    companions: backend.companions,
    history: backend.history,
    windows: backend.projectWindows,
    syncProject: backend.syncProject,
    settleSaves: backend.settleSaves,
    itemStore,
    canvas,
    effects: domEffects,
  })
  return {
    services: {
      backend,
      workspace,
      ui,
      chat,
      navigation,
      commands,
      canvas,
      itemStore,
      landing,
      drag: createDragSession(),
    },
    sync: { workspace, ui, now, panels, bind, settle },
  }
}

// Creates the backend, stores and navigation once, keeps them in step with the URL,
// and shares them with its children. Navigation re-renders stop here: the tree
// arrives as `children` and reads the stores instead of the router.
export const WorkspaceProvider = ({
  createBackend,
  children,
}: {
  readonly createBackend: CreateBackend
  readonly children: ReactNode
}): React.JSX.Element => {
  const location = useLocation()
  const navigationType = useNavigationType()
  const navigate = useNavigate()
  const [{ services, sync }] = useState(() =>
    createServices(createBackend, location, navigationType),
  )
  useEffect(
    () =>
      connectBackend(
        services.backend,
        services.workspace,
        services.commands.openRequested,
        services.commands.removedElsewhere,
      ),
    [services],
  )
  useEffect(() => services.itemStore?.connect(), [services])
  // Messages join their terminal's bar, which a backend with items draws.
  useEffect(() => {
    const { itemStore, backend, workspace } = services
    return itemStore && backend.messages ? followMessages(workspace, backend.messages) : undefined
  }, [services])
  useEffect(() => persistUi(services.ui, services.workspace), [services])
  useEffect(() => watchAppearance(services.ui, window, services.backend.showAppearance), [services])
  useEffect(() => watchScale(services.ui, services.backend.showScale), [services])
  useEffect(
    () => followSavedPreferences(services.ui, window, services.commands.updatePreferences),
    [services],
  )
  useEffect(() => watchPresentation(services.workspace, services.ui), [services])
  useEffect(() => trackRecent(services.workspace, services.ui), [services])
  useEffect(() => watchSwitcher(services.workspace, services.ui), [services])
  useEffect(() => {
    const { arrange, arranged } = services.backend
    return arrange ? keepProjectArrangement(services.ui, arrange, arranged) : undefined
  }, [services])
  useEffect(() => watchCrashLoop(services.backend.crashLoop?.crashes, services.ui), [services])
  useEffect(() => watchUpdates(services.backend.updates, services.ui), [services])
  useEffect(
    () =>
      watchExperimental(
        services.backend.updates,
        (on) => services.commands.setFeatureFlag("IS_EXPERIMENTAL", on),
        services.backend,
      ),
    [services],
  )
  // What is new is told once, in the app's first window.
  useEffect(
    () =>
      services.backend.projectWindows?.extra
        ? undefined
        : watchWhatsNew(services.backend.whatsNew, services.ui),
    [services],
  )
  useEffect(() => watchSandbox(services.backend.sandbox, services.ui), [services])
  useEffect(() => watchPortable(services.backend.portable, services.ui), [services])
  useEffect(() => watchClosing(services.workspace, services.ui), [services])
  useEffect(() => watchMoving(services.workspace, services.ui), [services])
  useEffect(() => {
    const { history } = services.backend
    return history && historyShown(services.backend)
      ? watchHistoryDrops(history, services.workspace, services.ui)
      : undefined
  }, [services])
  useEffect(() => watchChat(services.chat, services.workspace), [services])
  useEffect(() => watchPageFocus(services.ui, window, services.backend.windowFocus), [services])
  useEffect(
    () => watchProjectWindows(services.backend, services.workspace, services.ui),
    [services],
  )
  useEffect(
    () =>
      watchWindowTitle(window, services.backend.projectWindows, services.workspace, services.ui),
    [services],
  )
  useEffect(
    () => watchWindowControls(services.ui, window, services.backend.windowControls),
    [services],
  )
  useEffect(
    () => watchActiveTerminal(services.workspace, services.ui, services.backend.activeTerminal),
    [services],
  )
  // Before the watchers below, which read the landed Inbox. The Inbox's own watchers, in child
  // effects, subscribe first; until it starts, the landed Inbox holds the rule's computed state.
  useEffect(() => services.landing.start(), [services])
  useEffect(() => {
    const { backend, workspace, ui, landing } = services
    const board = noticeBoard(backend.notices, dingOf(backend, ui))
    const stops = [watchFinishes(workspace, nameFinished(services))]
    if (backend.inbox)
      stops.push(
        watchUnreadTurns(backend.inbox, workspace, ui, {
          notify: board && ((notice, itemId) => board.show("finish", notice, itemId)),
          clear: board && ((terminalId) => board.close("finish", terminalId)),
        }),
      )
    if (backend.inbox) stops.push(watchBellRings(landing.inbox, ui))
    if (backend.inbox && (board || backend.badge))
      stops.push(
        watchInboxPings(landing.inbox, ui, {
          board,
          badge: backend.badge,
        }),
      )
    return () => stops.forEach((stop) => stop())
  }, [services])
  useEffect(() => services.backend.inbox?.bind?.({ workspace: services.workspace }), [services])
  useRouteSync(sync, { location, navigationType, navigate })
  // The works' pull requests, for the changes items wherever they show.
  const pullRequests = useMemo(() => pullRequestsOf(services.backend), [services])
  // What of each session's teams the person has seen drawn, so the team wires play only news.
  const teamNews = useMemo(
    () => createTeamNews(() => currentContext(services.workspace.getSnapshot())),
    [services],
  )
  return (
    <WorkspaceServicesContext value={services}>
      <DragSessionContext value={services.drag}>
        <PullRequestsContext value={pullRequests}>
          <TeamNewsContext value={teamNews}>{children}</TeamNewsContext>
        </PullRequestsContext>
      </DragSessionContext>
    </WorkspaceServicesContext>
  )
}
