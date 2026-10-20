import type { SidebarPanel, ViewMode } from "@novadeck/core/types"

export type KeyboardFocus = { readonly id: string; readonly view: ViewMode }
export type CanvasKeyboardFocus = {
  readonly context: string
  readonly id: string
  readonly request: number
}
// How a view brings the selection into sight: as it is, framed alone, or, on Canvas, with
// the camera flown in to it as a header's double-click does.
export type NavigationMove = "center" | "fit" | "fly"
export type ShellNavigation = { readonly count: number; readonly move: NavigationMove }
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
  // Keys move around the workspace instead of reaching a terminal, from Shift+Esc until
  // the person goes back into one.
  readonly navigate: boolean
}

export const initialShell = (sidebarCollapsed: boolean): ShellState => ({
  sidebar: false,
  sidebarCollapsed,
  zen: null,
  revealCanvas: false,
  keyboardFocus: null,
  canvasKeyboardFocus: null,
  navigation: { count: 1, move: "center" },
  focusPreview: null,
  freshSession: null,
  navigate: false,
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

// A navigation that flies, as the stage keeps it: the pulse it came with, and the session
// (`context`) and view on screen then. It is for that view alone: once the view or the session
// changes it is spent, and a view the session opens into later frames as it would.
export type Flight = {
  readonly count: number
  readonly context: string
  readonly view: ViewMode
  readonly spent: boolean
}

// The flight as a stage first sees it: one from before it mounted, as when the window
// crosses the desktop width, was never for it.
export const firstFlight = (
  navigation: ShellNavigation,
  context: string,
  view: ViewMode,
): Flight => ({
  count: navigation.count,
  context,
  view,
  spent: true,
})

// The flight after the stage renders with `navigation` on `context`'s `view`: a new pulse
// is for what is on screen now, and one already seen is spent once either changes.
export const flightAfter = (
  flight: Flight,
  navigation: ShellNavigation,
  context: string,
  view: ViewMode,
): Flight => {
  if (flight.count !== navigation.count)
    return { count: navigation.count, context, view, spent: false }
  if (!flight.spent && (flight.context !== context || flight.view !== view))
    return { ...flight, spent: true }
  return flight
}

// Whether the view on screen flies in to the selection.
export const flies = (
  flight: Flight,
  navigation: ShellNavigation,
  context: string,
  view: ViewMode,
): boolean =>
  navigation.move === "fly" &&
  flight.count === navigation.count &&
  !flight.spent &&
  flight.context === context &&
  flight.view === view

export const bumpNavigation = (shell: ShellState, move: NavigationMove = "center"): ShellState => ({
  ...shell,
  navigation: { count: shell.navigation.count + 1, move },
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
