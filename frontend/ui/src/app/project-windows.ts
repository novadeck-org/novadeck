import type { ProjectWindows } from "@novadeck/core/desktop/project-windows"
import type { Backend } from "@novadeck/core/port"
import { activeProject } from "@novadeck/core/state"
import type { Store } from "@novadeck/core/store"
import type { Workspace } from "@novadeck/core/types"

import { projectWindowsOn } from "./selectors"
import type { UiState, UiStore } from "./ui-store"

export { projectWindowsOn, shownElsewhere } from "./selectors"

// Project windows: each window of the desktop app shows one project, and a project shows in
// at most one window. The app (main process) knows which window shows what; this page hears
// the projects the others show (`UiState.windows`) and tells the app what it shows.

// Whether this window has the voice: it rings, raises notifications and counts on the app's
// icon. A window that hears nothing from the app has it.
export const hasVoice = (state: Pick<UiState, "windows">): boolean => state.windows.voice

// What the window's title says: the project it shows, with project windows on, so the taskbar
// and the window menu tell the windows apart; the app's name alone otherwise.
export const windowTitle = (projectName: string | undefined, on: boolean): string =>
  on && projectName ? `${projectName} — Novadeck` : "Novadeck"

// The most projects a window tells the app it knows.
const knownProjectsLimit = 256

// How long a window with the feature on waits for the Experimental switch before it tells the
// app the feature is off.
export const flagGraceMs = 3_000

// Follows the app's windows: what the others show is kept in `ui`, and the project this window
// shows, and whether the person has project windows on, are told to the app as they change.
// Returns the stop.
export const watchProjectWindows = (
  backend: Pick<Backend, "projectWindows" | "showingProject" | "limitSaves">,
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
        : { ...current, windows: state },
    ),
  )
  let shown: string | undefined
  let known = ""
  // With project windows on, the runner is told which project this window shows, so what an
  // agent asks of the person reaches the window that shows its project, and this window saves
  // only that project's sessions, the others' copies here being stale until it shows them.
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
    const scope = id !== undefined && projectWindowsOn(ui.getSnapshot(), windows) ? id : null
    if (scope === scoped) return
    scoped = scope
    backend.showingProject?.(scope)
    backend.limitSaves?.(scope)
  }
  // Whether the Experimental switch has had time to be read: it comes from the app a moment
  // after the page starts, and a window that opens with the feature on must not tell the app it
  // is off meanwhile, which would forget the windows kept for the next launch.
  let settled = !ui.getSnapshot().preferences.projectWindows
  let used: boolean | undefined
  const useFeature = (): void => {
    const on = projectWindowsOn(ui.getSnapshot(), windows)
    if (on === used || (!settled && !on)) return
    used = on
    windows.use(on)
  }
  const settling = setTimeout(() => {
    settled = true
    useFeature()
  }, flagGraceMs)
  showProject()
  useFeature()
  const stopWorkspace = workspace.subscribe(showProject)
  const stopUi = ui.subscribe(() => {
    showProject()
    useFeature()
  })
  return () => {
    clearTimeout(settling)
    stopState()
    stopWorkspace()
    stopUi()
  }
}

// Keeps the document's title, which the desktop app shows as the window's, naming the project
// this window shows while project windows are on. Returns the stop.
export const watchWindowTitle = (
  view: { readonly document: Pick<Document, "title"> },
  windows: ProjectWindows | undefined,
  workspace: Store<Workspace>,
  ui: UiStore,
): (() => void) => {
  if (!windows) return () => {}
  const update = (): void => {
    view.document.title = windowTitle(
      activeProject(workspace.getSnapshot())?.name,
      projectWindowsOn(ui.getSnapshot(), windows),
    )
  }
  update()
  const stopWorkspace = workspace.subscribe(update)
  const stopUi = ui.subscribe(update)
  return () => {
    stopWorkspace()
    stopUi()
    view.document.title = "Novadeck"
  }
}
