import { createRef, useEffect, useState, type ReactNode } from "react"
import { useLocation, useNavigate, useNavigationType, type Location } from "react-router"

import type { CreateBackend } from "../backend/port"
import type { CanvasHandle } from "../layouts/canvas/types"
import { workspaceFromSeed } from "../model/seed"
import { createWorkspaceStore } from "../model/store"
import { readPreferences } from "../preferences/preferences-storage"
import { readSidebarCollapsed, readWindowedView } from "../shell/shell-storage"
import { createPanes } from "../terminals/companion/state"
import { createDragSession, DragSessionContext } from "../terminals/drag-session"
import { followSavedPreferences, watchAppearance } from "./appearance"
import { createNavigator, type NavigatorServices, type RouterBinding } from "./commands/navigator"
import { createWorkspaceCommands } from "./commands/workspace"
import { connectBackend } from "./controller/backend-connection"
import { WorkspaceServicesContext, type WorkspaceServices } from "./controller/context"
import { domEffects } from "./controller/effects"
import { dialogDepthOf, useRouteSync } from "./controller/useRouteSync"
import { watchPageFocus } from "./page-focus"
import { resolveRoute } from "./routing"
import {
  createUiStore,
  initialUi,
  persistUi,
  trackRecent,
  watchPresentation,
  watchChatModes,
  watchClosing,
  watchCrashLoop,
  watchFinishes,
  watchSwitcher,
  type UiLocation,
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
  const ui = createUiStore(
    initialUi({
      location: { route, dialogDepth: dialogDepthOf(location.state), navigationType },
      preferences,
      sidebarCollapsed: readSidebarCollapsed(),
    }),
  )
  const { bind, settle, ...navigation } = createNavigator({ workspace, ui, now })
  const canvas = createRef<CanvasHandle>()
  const panes =
    backend.companions &&
    createPanes({ companions: backend.companions, workspace, messages: backend.messages })
  const commands = createWorkspaceCommands({
    workspace,
    ui,
    navigation,
    newTerminal: backend.newTerminal,
    pickDirectory: backend.pickDirectory,
    crashLoop: backend.crashLoop,
    resetTitle: backend.resetTitle,
    panes,
    canvas,
    effects: domEffects,
  })
  return {
    services: {
      backend,
      workspace,
      ui,
      navigation,
      commands,
      canvas,
      panes,
      drag: createDragSession(),
    },
    sync: { workspace, ui, now, bind, settle },
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
  useEffect(() => watchClosing(services.workspace, services.ui), [services])
  useEffect(() => watchChatModes(services.workspace, services.ui), [services])
  useEffect(() => watchPageFocus(services.ui, window), [services])
  useEffect(
    () => watchFinishes(services.workspace, services.ui, services.backend.notices?.show),
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
