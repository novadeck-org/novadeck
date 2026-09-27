export type ViewMode = "focus" | "grid" | "canvas"
export type WindowedView = Exclude<ViewMode, "focus">
export type PreferencesValue = { fontSize: number; enabledViews: ViewMode[] }
export type Project = { id: string; name: string; directory: string }

// What a terminal's process is doing. Exit and failure details replace each other.
export type TerminalStatus =
  | { readonly state: "starting" | "running" | "idle" | "finished" }
  | { readonly state: "exited"; readonly exitCode: number | null }
  | { readonly state: "failed"; readonly message: string }

export type TerminalMetadata = {
  id: string
  name: string
  directory: string
  command: string
  process: string
  kind: "shell" | "server" | "tests" | "git" | "logs" | "build" | "claude" | "codex"
} & TerminalStatus

export type CanvasLayout = {
  viewport?: { x: number; y: number; zoom: number }
  minimized: Record<string, boolean>
  geometry: Record<
    string,
    {
      position: { x: number; y: number }
      measured?: { width?: number; height?: number }
      dragging?: boolean
      resizing?: boolean
      width?: number
      height?: number
    }
  >
}
export type GridBreakpoint = "wide" | "desktop" | "tablet" | "mobile"
export type GridItem = {
  i: string
  x: number
  y: number
  w: number
  h: number
  minW?: number
  maxW?: number
  minH?: number
  maxH?: number
  static?: boolean
  isDraggable?: boolean
  isResizable?: boolean
  resizeHandles?: ("s" | "w" | "e" | "n" | "sw" | "nw" | "se" | "ne")[]
  isBounded?: boolean
  moved?: boolean
}
export type GridLayouts = Partial<Record<GridBreakpoint, readonly GridItem[]>>
export type GridRestoreWidths = Partial<Record<GridBreakpoint, number>>

export type SizePreset = "large" | "small"

// The session's terminals: metadata, sidebar order, and the next default number.
export type TerminalRoster = {
  readonly terminals: TerminalMetadata[]
  readonly order: string[]
  readonly nextNumber: number
}
// Where each terminal sits and how big it is in each view.
export type TerminalLayout = {
  readonly canvas: CanvasLayout
  readonly grid: GridLayouts
  readonly gridRestoreWidths: Record<string, GridRestoreWidths>
  readonly gridMinimized: Record<string, boolean>
  readonly sizePresets: Record<WindowedView, Record<string, SizePreset>>
  readonly hidden: Record<string, boolean>
}
export type WorkspaceState = {
  readonly roster: TerminalRoster
  readonly layout: TerminalLayout
  // Navigation memory mirrored from the URL, which stays authoritative.
  readonly view: ViewMode
  readonly windowedView: WindowedView
  readonly selected: string
}
export type WorkspaceSession = {
  id: string
  name: string
  visitedAt: number
  state: WorkspaceState
}
export type WorkspaceProject = Project & { activeSessionId: string; history: WorkspaceSession[] }
export type Workspace = { projects: WorkspaceProject[]; activeProjectId: string }
export type WorkspaceTarget = { projectId: string; workspaceSessionId: string }
