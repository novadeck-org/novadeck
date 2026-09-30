export type ViewMode = "focus" | "grid" | "canvas"
export type WindowedView = Exclude<ViewMode, "focus">
export type PreferencesValue = { fontSize: number; enabledViews: ViewMode[] }
export type Project = { id: string; name: string; directory: string }

// What the agent running in a terminal says it is doing: working on a turn or waiting
// for the next prompt, whether it plans rather than acts, how many of its requests wait
// on the person, by the kind of the oldest: permission for a tool, a question, or a plan
// to review, and the subagents it runs, oldest first.
export type AgentStatus = {
  readonly working: boolean
  readonly planning?: true
  readonly attention?: {
    readonly kind: "permission" | "question" | "plan"
    readonly count: number
  }
  readonly subagents?: readonly { readonly id: string; readonly type: string | null }[]
  readonly usage?: AgentUsage
}

// What an agent's own records say of its tokens and quotas: how many tokens its context
// holds, of how many where known, and each rate-limit window's used fraction with when it
// resets, in epoch milliseconds.
export type AgentUsage = {
  readonly context: { readonly occupied: number; readonly capacity: number | null } | null
  readonly limits: readonly {
    readonly minutes: number | null
    readonly used: number
    readonly resetsAt: number | null
  }[]
}

// What a terminal's process is doing. Exit and failure details replace each other.
// An exited process reports its code, or the signal that killed it. A running agent
// that reports through its hooks adds what it is doing.
export type TerminalStatus =
  | { readonly state: "starting" | "idle" | "finished" }
  | { readonly state: "running"; readonly agent?: AgentStatus }
  | { readonly state: "exited"; readonly exitCode: number | null; readonly signal: string | null }
  | { readonly state: "failed"; readonly message: string }

export type TerminalMetadata = {
  id: string
  name: string
  directory: string
  command: string
  // The foreground program's name, as `programName` resolves it.
  process: string
  // The program to resume in the terminal's next shell: one that was running when its
  // shell was lost or ended, or when the app last closed. Present only while the
  // terminal has no live shell.
  restoredProcess?: string
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
