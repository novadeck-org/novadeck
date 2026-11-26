import type { Backend } from "@novadeck/core/port"
import { hasTile } from "@novadeck/core/roster"
import {
  activeProject,
  activeSession,
  workspaceReducer,
  type WorkspaceAction,
} from "@novadeck/core/state"
import type { WorkspaceTransaction } from "@novadeck/core/store"
import {
  panelNamed,
  sidebarPanels,
  type PreferencesValue,
  type SidebarPanel,
  type ViewMode,
  type Workspace,
} from "@novadeck/core/types"
import { matchPath } from "react-router"

import { fallbackTab, preferencesTabOf, type PreferencesTab } from "../preferences/settings"

export type WorkspaceRoute = {
  projectId: string
  sessionId: string
  view: ViewMode
  terminal: string
  panel: SidebarPanel
  dialog: "search" | "preferences" | null
  // The Preferences page the URL names; null where it names none, and Preferences opens Agents
  // where it has the page, else Appearance.
  section: PreferencesTab | null
}

// URL-driven navigation over the workspace and UI stores. Each call commits the
// destination's workspace actions and route before it navigates, so a command's
// store changes and its URL change render together.
export type WorkspaceNavigator = {
  readonly go: (changes: Partial<WorkspaceRoute>, replace?: boolean) => void
  // Commits actions first, then navigates to the route they produce.
  readonly navigateWorkspace: (
    actions: WorkspaceTransaction,
    changes?: Partial<WorkspaceRoute>,
    replace?: boolean,
  ) => void
  // Returns through history to the dialog's background entry when there is one.
  readonly closeDialog: () => void
  readonly href: (changes: Partial<WorkspaceRoute>) => string
}

export const workspaceRoute = (workspace: Workspace): WorkspaceRoute => ({
  projectId: workspace.activeProjectId,
  sessionId: activeProject(workspace)!.activeSessionId,
  view: activeSession(workspace)!.state.view,
  terminal: activeSession(workspace)!.state.selected,
  panel: "terminals",
  dialog: null,
  section: null,
})

// The Preferences page a URL names: none where it names none, a former page's successor, and
// Appearance where the name was never a page's.
const sectionOf = (name: string | null): PreferencesTab | null =>
  name === null ? null : (preferencesTabOf(name) ?? fallbackTab)

// Whether the app shows the Files panel: where the backend has the project's files to show.
export const filesShown = (backend: Pick<Backend, "files">): boolean => backend.files !== undefined

// Whether the app shows the History panel: where the backend keeps the terminals closed.
export const historyShown = (backend: Pick<Backend, "history">): boolean =>
  backend.history !== undefined

// Whether the backend reports each tracked worktree's work, which the Worktrees panel lists.
export const reportsWorks = (backend: Pick<Backend, "works">): boolean =>
  backend.works !== undefined

// The panels a backend can show: Files only where it reads the projects' files, History only
// where it keeps closed terminals, Worktrees only where it reports the worktrees' work.
export const availablePanels = (
  hasFiles: boolean,
  hasHistory = false,
  hasWorktrees = false,
): readonly SidebarPanel[] =>
  sidebarPanels.filter(
    (panel) =>
      (hasFiles || panel !== "files") &&
      (hasHistory || panel !== "history") &&
      (hasWorktrees || panel !== "worktrees"),
  )

// Whether the rail shows the panel now: one the backend has, and Worktrees only while the person
// has agent worktrees on, or the tour's project is on screen (`inTour`; see `useWorktreesShown`).
export const panelShownOn =
  (
    backend: Pick<Backend, "files" | "history" | "works" | "worktrees">,
    inTour: () => boolean = () => false,
  ) =>
  (panel: SidebarPanel): boolean =>
    availablePanels(filesShown(backend), historyShown(backend), reportsWorks(backend)).includes(
      panel,
    ) &&
    (panel !== "worktrees" || (backend.worktrees?.enabled.getSnapshot() ?? false) || inTour())

// The sidebar panel a URL names, Terminals for anything else, or for one the backend lacks.
const panelOf = (name: string | null, panels: readonly SidebarPanel[]): SidebarPanel => {
  const named = name === null ? undefined : panelNamed(name)
  return named !== undefined && panels.includes(named) ? named : "terminals"
}

export const routeUrl = (route: WorkspaceRoute): string => {
  const search = new URLSearchParams()
  // Keep an explicit empty selection so Canvas can have no active terminal.
  search.set("terminal", route.terminal)
  if (route.panel !== "terminals") search.set("panel", route.panel)
  if (route.dialog) search.set("dialog", route.dialog)
  if (route.dialog === "preferences" && route.section !== null) search.set("section", route.section)
  return `/projects/${encodeURIComponent(route.projectId)}/sessions/${encodeURIComponent(route.sessionId)}/${route.view}?${search}`
}

export const resolveRoute = (
  workspace: Workspace,
  location: { pathname: string; search: string },
  preferences: PreferencesValue,
  now: number,
  panels: readonly SidebarPanel[],
): { workspace: Workspace; route: WorkspaceRoute; actions: WorkspaceAction[] } => {
  const match = matchPath("/projects/:projectId/sessions/:sessionId/:view", location.pathname)
  const params = match?.params
  const project =
    workspace.projects.find((item) => item.id === params?.projectId) ?? activeProject(workspace)!
  const session =
    project.history.find((item) => item.id === params?.sessionId) ??
    project.history.find((item) => item.id === project.activeSessionId)!
  let next = workspace
  const actions: WorkspaceAction[] = []
  const apply = (action: WorkspaceAction): Workspace => {
    actions.push(action)
    next = workspaceReducer(next, action)
    return next
  }
  if (next.activeProjectId !== project.id)
    next = apply({ type: "project/select", projectId: project.id, now })
  if (project.activeSessionId !== session.id)
    next = apply({
      type: "session/select",
      projectId: project.id,
      workspaceSessionId: session.id,
      now,
    })
  const view =
    preferences.enabledViews.find((item) => item === params?.view) ??
    (preferences.enabledViews.includes(session.state.view)
      ? session.state.view
      : preferences.enabledViews[0]!)
  const search = new URLSearchParams(location.search)
  const requestedTerminal = search.get("terminal")
  const terminal =
    requestedTerminal === "" || hasTile(session.state.roster, requestedTerminal ?? "")
      ? requestedTerminal!
      : session.state.selected
  const target = { projectId: project.id, workspaceSessionId: session.id }
  if (session.state.view !== view)
    next = apply({
      type: "view/change",
      target,
      view,
      enabledViews: preferences.enabledViews,
    })
  if (session.state.selected !== terminal)
    next = apply({ type: "terminal/select", target, terminalId: terminal })
  const dialog = search.get("dialog")
  return {
    workspace: next,
    actions,
    route: {
      projectId: project.id,
      sessionId: session.id,
      view,
      terminal,
      panel: panelOf(search.get("panel"), panels),
      dialog: dialog === "search" || dialog === "preferences" ? dialog : null,
      section: dialog === "preferences" ? sectionOf(search.get("section")) : null,
    },
  }
}
