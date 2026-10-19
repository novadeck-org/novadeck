import { createDragSession, DragSessionContext } from "@novadeck/companion/drag-session"
import { createPanes } from "@novadeck/companion/state"
import type { CreateBackend } from "@novadeck/core/port"
import { workspaceFromSeed } from "@novadeck/core/seed"
import { createWorkspaceStore, type Store } from "@novadeck/core/store"
import { createRef, useEffect, useState, type ReactNode } from "react"
import { useLocation, useNavigate, useNavigationType, type Location } from "react-router"

import type { CanvasHandle } from "../layouts/canvas/types"
import { readPreferences } from "../preferences/preferences-storage"
import { readProjectArrangement } from "../projects/project-arrangement-storage"
import { readSidebarCollapsed, readWindowedView } from "../shell/shell-storage"
import { createChat, watchChat } from "../terminals/chat/state"
import { followSavedPreferences, watchAppearance } from "./appearance"
import { createNavigator, type NavigatorServices, type RouterBinding } from "./commands/navigator"
import { createWorkspaceCommands } from "./commands/workspace"
import { connectBackend } from "./controller/backend-connection"
import { WorkspaceServicesContext, type WorkspaceServices } from "./controller/context"
import { domEffects } from "./controller/effects"
import { dialogDepthOf, useRouteSync } from "./controller/useRouteSync"
import { nameFinished } from "./murmur-offer"
import { watchPageFocus } from "./page-focus"
import { resolveRoute } from "./routing"
import {
  createUiStore,
  initialUi,
  persistUi,
  trackRecent,
  watchPresentation,
  watchClosing,
  watchCrashLoop,
  watchFinishes,
  watchSwitcher,
  watchPortable,
  watchSandbox,
  watchUpdates,
  type UiLocation,
  type UiState,
  type UiStore,
} from "./ui-store"

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
  const { workspace: initial, route } = resolveRoute(seeded, location, preferences, now())
  const workspace = createWorkspaceStore(initial, backend.commit)
  // The store only reports later commits; give the backend the starting terminals now.
  backend.commit(initial, [])
  // Terminals mount in layout effects, before any effect of the app's could tell the font.
  backend.setFont({ size: preferences.fontSize })
  const ui = createUiStore(
    initialUi({
      location: { route, dialogDepth: dialogDepthOf(location.state), navigationType },
      preferences,
      sidebarCollapsed: readSidebarCollapsed(),
      projectArrangement: readProjectArrangement(),
    }),
  )
  const chat = createChat()
  const { bind, settle, ...navigation } = createNavigator({ workspace, ui, now })
  const canvas = createRef<CanvasHandle>()
  const panes =
    backend.companions &&
    createPanes({ companions: backend.companions, workspace, messages: backend.messages })
  const commands = createWorkspaceCommands({
    workspace,
    ui,
    chat,
    navigation,
    newTerminal: backend.newTerminal,
    inbox: backend.inbox,
    pickDirectory: backend.pickDirectory,
    crashLoop: backend.crashLoop,
    resetTitle: backend.resetTitle,
    murmur: backend.murmur,
    conversations: backend.conversations,
    panes,
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
      panes,
      drag: createDragSession(),
    },
    sync: { workspace, ui, now, bind, settle },
  }
}

// The UI store's unread finishes as a store of their own, heard only when they change.
const unreadOf = (ui: UiStore): Store<UiState["unread"]> => ({
  getSnapshot: () => ui.getSnapshot().unread,
  subscribe: (listener) => {
    let before = ui.getSnapshot().unread
    return ui.subscribe(() => {
      const unread = ui.getSnapshot().unread
      if (unread === before) return
      before = unread
      listener()
    })
  },
})

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
    () => connectBackend(services.backend, services.workspace, services.commands.openRequested),
    [services],
  )
  useEffect(() => services.panes?.connect(), [services])
  useEffect(() => persistUi(services.ui, services.workspace), [services])
  useEffect(() => watchAppearance(services.ui, window, services.backend.showAppearance), [services])
  useEffect(
    () => followSavedPreferences(services.ui, window, services.commands.updatePreferences),
    [services],
  )
  useEffect(() => watchPresentation(services.workspace, services.ui), [services])
  useEffect(() => trackRecent(services.workspace, services.ui), [services])
  useEffect(() => watchSwitcher(services.workspace, services.ui), [services])
  useEffect(() => watchCrashLoop(services.backend.crashLoop?.crashes, services.ui), [services])
  useEffect(() => watchUpdates(services.backend.updates, services.ui), [services])
  useEffect(() => watchSandbox(services.backend.sandbox, services.ui), [services])
  useEffect(() => watchPortable(services.backend.portable, services.ui), [services])
  useEffect(() => watchClosing(services.workspace, services.ui), [services])
  useEffect(() => watchChat(services.chat, services.workspace), [services])
  useEffect(() => watchPageFocus(services.ui, window), [services])
  useEffect(
    () =>
      watchFinishes(services.workspace, services.ui, {
        notify: services.backend.notices?.show,
        unread: services.backend.murmur?.gist,
        finished: nameFinished(services),
      }),
    [services],
  )
  useEffect(
    () =>
      services.backend.inbox?.bind?.({
        workspace: services.workspace,
        unread: unreadOf(services.ui),
        read: services.commands.dismissAllNotifications,
      }),
    [services],
  )
  useEffect(() => services.backend.notices?.onClick(services.commands.reveal), [services])
  useRouteSync(sync, { location, navigationType, navigate })
  return (
    <WorkspaceServicesContext value={services}>
      <DragSessionContext value={services.drag}>{children}</DragSessionContext>
    </WorkspaceServicesContext>
  )
}
