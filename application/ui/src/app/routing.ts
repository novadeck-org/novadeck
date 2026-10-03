import { matchPath } from "react-router"

import { hasTile } from "../model/roster"
import {
  activeProject,
  activeSession,
  workspaceReducer,
  type WorkspaceAction,
} from "../model/state"
import type { WorkspaceTransaction } from "../model/store"
import type { PreferencesValue, ViewMode, Workspace } from "../model/types"

export type WorkspaceRoute = {
  projectId: string
  sessionId: string
  view: ViewMode
  terminal: string
  panel: "terminals" | "sessions"
  dialog: "search" | "preferences" | null
  section: "general" | "shortcuts"
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
  section: "general",
})

export const routeUrl = (route: WorkspaceRoute): string => {
  const search = new URLSearchParams()
  // Keep an explicit empty selection so Canvas can have no active terminal.
  search.set("terminal", route.terminal)
  if (route.panel === "sessions") search.set("panel", route.panel)
  if (route.dialog) search.set("dialog", route.dialog)
  if (route.dialog === "preferences" && route.section === "shortcuts")
    search.set("section", route.section)
  return `/projects/${encodeURIComponent(route.projectId)}/sessions/${encodeURIComponent(route.sessionId)}/${route.view}?${search}`
}

export const resolveRoute = (
  workspace: Workspace,
  location: { pathname: string; search: string },
  preferences: PreferencesValue,
  now: number,
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
      panel: search.get("panel") === "sessions" ? "sessions" : "terminals",
      dialog: dialog === "search" || dialog === "preferences" ? dialog : null,
      section:
        dialog === "preferences" && search.get("section") === "shortcuts" ? "shortcuts" : "general",
    },
  }
}
