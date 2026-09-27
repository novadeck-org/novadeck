import type { ViewMode } from "../model/types"

export type SidebarPanel = "sessions" | "terminals"
export type KeyboardFocus = { readonly id: string; readonly view: ViewMode }
export type CanvasKeyboardFocus = {
  readonly context: string
  readonly id: string
  readonly request: number
}
export type ShellNavigation = { readonly count: number; readonly fit: boolean }
export type ZenState = {
  readonly sidebar: boolean
  readonly collapsed: boolean
  readonly panel: SidebarPanel
}
export type FocusPreview = { readonly context: string; readonly id: string }

// Presentation state around the workspace: sidebar, Zen, navigation pulses and focus
// requests. Only `sidebarCollapsed` outlives a reload.
export type ShellState = {
  // The phone drawer is open.
  readonly sidebar: boolean
  // The desktop sidebar is collapsed.
  readonly sidebarCollapsed: boolean
  // Zen hides the chrome and remembers the sidebar to restore on exit.
  readonly zen: ZenState | null
  // Canvas centres on the selection when it next mounts.
  readonly revealCanvas: boolean
  // The terminal whose input takes keyboard focus once it shows in this view.
  readonly keyboardFocus: KeyboardFocus | null
  readonly canvasKeyboardFocus: CanvasKeyboardFocus | null
  // Each increment asks the view to bring the selection into sight.
  readonly navigation: ShellNavigation
  // The terminal Focus keeps showing after the selection is cleared.
  readonly focusPreview: FocusPreview | null
  // A session created from the sidebar, which opens the phone drawer once it shows.
  readonly freshSession: string | null
}

export const initialShell = (sidebarCollapsed: boolean): ShellState => ({
  sidebar: false,
  sidebarCollapsed,
  zen: null,
  revealCanvas: false,
  keyboardFocus: null,
  canvasKeyboardFocus: null,
  navigation: { count: 1, fit: false },
  focusPreview: null,
  freshSession: null,
})

export const sidebarVisible = (shell: ShellState, desktop: boolean): boolean =>
  !shell.zen && (desktop ? !shell.sidebarCollapsed : shell.sidebar)

export const hideSidebar = (shell: ShellState): ShellState => ({
  ...shell,
  sidebarCollapsed: true,
  sidebar: false,
})

// Leaves Zen and opens the sidebar on whichever panel the route names.
export const showPanel = (shell: ShellState): ShellState => ({
  ...shell,
  zen: null,
  sidebarCollapsed: false,
  sidebar: true,
})

export const enterZen = (shell: ShellState, panel: SidebarPanel): ShellState =>
  shell.zen
    ? shell
    : { ...shell, zen: { sidebar: shell.sidebar, collapsed: shell.sidebarCollapsed, panel } }

// Restores the sidebar Zen remembered; the caller restores its panel.
export const exitZen = (shell: ShellState): ShellState =>
  shell.zen
    ? { ...shell, sidebar: shell.zen.sidebar, sidebarCollapsed: shell.zen.collapsed, zen: null }
    : shell

export const bumpNavigation = (shell: ShellState, fit = false): ShellState => ({
  ...shell,
  navigation: { count: shell.navigation.count + 1, fit },
})

// A new session, or Back/Forward to another view or selection, starts its
// presentation over: views recentre, Canvas does not reveal, and the phone drawer
// opens only for the session just created from it.
export const resetPresentation = (shell: ShellState, workspaceSessionId: string): ShellState => ({
  ...bumpNavigation(shell),
  revealCanvas: false,
  sidebar: shell.freshSession === workspaceSessionId,
  freshSession: null,
})
