import type { SchemePreference, ThemeId } from "../theme/themes"
import type { CompanionItem, ItemId } from "./companion"
import type { Bar } from "./companion-bar"

export type ViewMode = "focus" | "grid" | "canvas"
export type WindowedView = Exclude<ViewMode, "focus">
export type PreferencesValue = {
  fontSize: number
  enabledViews: ViewMode[]
  // The theme and the scheme chosen for it; see docs/theming.md.
  appearance: { readonly theme: ThemeId; readonly scheme: SchemePreference }
  // Whether the desktop app notifies the person when an agent finishes while they look
  // elsewhere.
  notifyFinished: boolean
}
export type Project = { id: string; name: string; directory: string }

// What the agent running in a terminal says it is doing: working on a turn or waiting
// for the next prompt, whether it plans rather than acts, how many of its requests wait
// on the person, by the kind of the oldest: permission for a tool, a question, or a plan
// to review, and the subagents it runs, oldest first.
export type AgentStatus = {
  // Working on its turn, or after it while subagents it started run on (`background`).
  readonly working: boolean
  // What its ended turn left running that wakes it once done, counted: subagents, and
  // other tasks such as commands. Both zero where its harness says only that work runs.
  readonly background?: { readonly agents: number; readonly tasks: number }
  readonly planning?: true
  readonly attention?: {
    readonly kind: "permission" | "question" | "plan"
    readonly count: number
  }
  readonly subagents?: readonly { readonly id: string; readonly type: string | null }[]
  readonly usage?: AgentUsage
  // How its latest turn ended, once none runs, with the start of its last reply where its
  // harness tells it (see `AgentTurnEnd`).
  readonly lastTurn?: AgentTurnEnd
}

// How an agent's turn ended: `completed` or `failed` on its own, `interrupted` by the
// person (Escape, or a request they refused), or `unknown` when it only went idle, as an
// Escape shows in Antigravity. `reply` is the start of its last reply, one line of plain
// text; `at` tells this end from any other.
export type AgentTurnEnd = {
  readonly outcome: "completed" | "failed" | "interrupted" | "unknown"
  readonly reply?: string
  readonly at: number
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

// Who a terminal's name is from: the person, an agent (by its terminal's handle), the
// person's first prompt there, or the backend's default.
export type TitleSource =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly by: string }
  | { readonly kind: "fallback" }
  | { readonly kind: "default" }

// A terminal as its backend reports it. The backend owns all of it: which terminals a
// session has, their names and directories, what they run and ran. The UI shows it and
// saves none of it; it keeps only how it shows them (`TerminalLayout`, sidebar order,
// the view), by terminal id.
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
  // The handle agents message it by, such as `t3`, where its backend has one.
  handle?: string
  // Who its name is from, where its backend tells.
  titleSource?: TitleSource
  // Never present: a window has one, which tells tiles apart (see `isWindow`).
  itemId?: never
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

// A companion item undocked into a window of its own, as its backend keeps it: which item
// it shows, and its name, the person's or the backend's default. It sits in the session
// beside the terminals, so the sidebar and every view treat it as one, but it runs nothing.
export type CompanionWindowMeta = {
  readonly id: string
  readonly itemId: ItemId
  readonly name: string
  readonly titleSource: Extract<TitleSource, { readonly kind: "person" | "default" }>
}

// Anything laid out by its id.
export type Placed = { readonly id: string }

// What the sidebar and views lay out: a terminal, or a window undocked from a companion.
export type Tile = TerminalMetadata | CompanionWindowMeta

// The session's terminals and windows, as the backend reports them, and their sidebar
// order, which holds both.
export type TerminalRoster = {
  readonly terminals: TerminalMetadata[]
  readonly windows: readonly CompanionWindowMeta[]
  readonly order: string[]
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
  // What agents showed and the person attached, as the backend reports them.
  readonly items: readonly CompanionItem[]
  // Each terminal's bar as the person arranged it, by terminal id.
  readonly bars: Readonly<Record<string, Bar>>
  // Items shown again or anew since the person last looked; never saved.
  readonly fresh: Readonly<Record<ItemId, true>>
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

// A terminal in a workspace session: what a backend and the UI name one by.
export type TerminalKey = WorkspaceTarget & { readonly terminalId: string }
