import type { ProjectWindows } from "@novadeck/core/desktop/project-windows"
import type { Backend } from "@novadeck/core/port"
import { activeProject } from "@novadeck/core/state"
import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import type { UiState, UiStore } from "./ui-store"

export { shownElsewhere } from "./selectors"

// Project windows: each window of the desktop app shows one project, and a project may show in
// several windows. The app (main process) knows which window shows what; this page hears
// the projects the others show (`UiState.windows`) and tells the app what it shows.

// Whether this window has the voice: it rings, raises notifications and counts on the app's
// icon. A window that hears nothing from the app has it.
export const hasVoice = (state: Pick<UiState, "windows">): boolean => state.windows.voice

// What the window's title says: the project it shows, so the taskbar and the window menu tell
// the windows apart; the app's name alone while it shows none.
export const windowTitle = (projectName: string | undefined): string =>
  projectName ? `${projectName} — Novadeck` : "Novadeck"

// The most projects a window tells the app it knows.
const knownProjectsLimit = 256

// Follows the app's windows: what the others show is kept in `ui`, and the project this window
// shows is told to the app as it changes. Returns the stop.
export const watchProjectWindows = (
  backend: Pick<Backend, "projectWindows" | "showingProject">,
  workspace: Store<Workspace>,
  ui: UiStore,
): (() => void) => {
  const { projectWindows: windows } = backend
  if (!windows) return () => {}
  const stopState = windows.onState((state) =>
    ui.update((current) =>
      current.windows.voice === state.voice &&
      current.windows.elsewhere.length === state.elsewhere.length &&
      current.windows.elsewhere.every((id, index) => id === state.elsewhere[index])
        ? current
        : {
            ...current,
            windows: state,
            windowsShared: current.windowsShared || state.elsewhere.length > 0,
          },
    ),
  )
  let shown: string | undefined
  let known = ""
  // While another window shows a project, the runner is told which project this one shows, so
  // what an agent asks of the person reaches the window that shows its project. A window alone
  // says nothing, as a browser doesn't, so the client the person used last gets it. Every window
  // saves what it changes in any project: the runner merges the windows' changes and feeds them
  // to each.
  let scoped: string | null = null
  const showProject = (): void => {
    const snapshot = workspace.getSnapshot()
    const id = activeProject(snapshot)?.id
    const ids = snapshot.projects.slice(0, knownProjectsLimit).map((project) => project.id)
    if (id !== shown || ids.join("\n") !== known) {
      shown = id
      known = ids.join("\n")
      windows.show(id ?? null, ids)
    }
    const others = ui.getSnapshot().windows.elsewhere.length > 0
    const scope = others ? (id ?? null) : null
    if (scope === scoped) return
    scoped = scope
    backend.showingProject?.(scope, others)
  }
  showProject()
  const stopWorkspace = workspace.subscribe(showProject)
  const stopUi = ui.subscribe(showProject)
  return () => {
    stopState()
    stopWorkspace()
    stopUi()
  }
}

// Keeps the document's title, which the desktop app shows as the window's, naming the project
// this window shows. Returns the stop.
export const watchWindowTitle = (
  view: { readonly document: Pick<Document, "title"> },
  windows: ProjectWindows | undefined,
  workspace: Store<Workspace>,
): (() => void) => {
  if (!windows) return () => {}
  const update = (): void => {
    view.document.title = windowTitle(activeProject(workspace.getSnapshot())?.name)
  }
  update()
  const stopWorkspace = workspace.subscribe(update)
  return () => {
    stopWorkspace()
    view.document.title = "Novadeck"
  }
}
