import type { ProjectWindows, ProjectWindowTarget } from "@novadeck/core/desktop/project-windows"
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

// How long a window with the feature on waits for the Experimental switch before it tells the
// app the feature is off.
export const flagGraceMs = 3_000

// Follows the app's windows: what the others show is kept in `ui`, and the project this window
// shows, and whether the person has project windows on, are told to the app as they change.
// Returns the stop.
export const watchProjectWindows = (
  windows: ProjectWindows | undefined,
  workspace: Store<Workspace>,
  ui: UiStore,
): (() => void) => {
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
  const showProject = (): void => {
    const id = activeProject(workspace.getSnapshot())?.id
    if (id === shown) return
    shown = id
    windows.show(id ?? null)
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
  const stopUi = ui.subscribe(useFeature)
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

// Loads the page again on a project, and its terminal when the target names one, as the runner
// knows them now: for a place in a project made in another window after this one loaded, which
// this page has never heard of.
export const reloadOn = (
  view: { readonly location: Pick<Location, "hash" | "reload"> },
  { projectId, terminalId }: ProjectWindowTarget,
): void => {
  const search = terminalId === undefined ? "" : `?terminal=${encodeURIComponent(terminalId)}`
  view.location.hash = `/projects/${encodeURIComponent(projectId)}/sessions/_/_${search}`
  view.location.reload()
}
