import type { Bar } from "./companion-bar"
import type { Item, ItemId } from "./items"
import type { NoticeSound } from "./sounds"

// What the person chose for the page: a scheme, or whatever the system uses.
export type SchemePreference = "system" | "light" | "dark"
export type ViewMode = "focus" | "grid" | "canvas"
// The sidebar's panels, each with a toggle on the rail.
export const sidebarPanels = ["terminals", "source", "sessions", "inbox"] as const
export type SidebarPanel = (typeof sidebarPanels)[number]
export type WindowedView = Exclude<ViewMode, "focus">
export type PreferencesValue = {
  fontSize: number
  enabledViews: ViewMode[]
  // The theme and the scheme chosen for it; the theme is a plain id the app may not know.
  // See docs/theming.md.
  appearance: { readonly theme: string; readonly scheme: SchemePreference }
  // Whether the desktop app notifies the person when an agent needs them (an Inbox item that
  // waits on them) while Novadeck is in the background.
  notifyNeeds: boolean
  // Whether it notifies them when an agent finishes while Novadeck is in the background.
  notifyFinished: boolean
  // Whether Novadeck plays its own sound whenever it rings the person, a toast or a desktop
  // notification, and how loud, from 0 to 1.
  sound: boolean
  soundVolume: number
  // Which sound it plays: "theme" for the current theme's own, the default, or the id of
  // one of the app's sounds to ring with whatever the theme.
  soundChoice: "theme" | NoticeSound
  // Whether monospace text joins pairs such as => and != into one glyph. Off by default:
  // a terminal shows what a program printed.
  ligatures: boolean
  // Whether a terminal an agent runs in shows its conversation rather than its screen, on
  // a backend that reads conversations.
  chatView: boolean
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
  // While its turn runs, the subagents its harness counts running, where it does.
  readonly background?: { readonly agents: number; readonly tasks: number }
  readonly planning?: true
  readonly attention?: {
    readonly kind: "permission" | "question" | "plan"
    readonly count: number
  }
  readonly subagents?: readonly { readonly id: string; readonly type: string | null }[]
  // What its ended turn waits on, which wakes it with no word from anyone (see
  // `AgentWaiting`); absent while it works or waits on nothing.
  readonly waiting?: AgentWaiting
  // How its latest turn ended, once none runs, with the start of its last reply where its
  // harness tells it (see `AgentTurnEnd`).
  readonly lastTurn?: AgentTurnEnd
  // Its `done` report still stands: nothing the person prompted or a message delivered to it
  // came after. Looking at the terminal does not end it, so its done mark stays until then.
  readonly reported?: true
}

// What an idle agent waits on: jobs it left running and picks up once they finish, each in
// the agent's own words where it gave them (`description`, else only the `command`), with
// when it started and, where its harness gives up on it, when that is (`until`); and a
// wake-up it set itself, with when (`at`) and why. All times are epoch milliseconds.
export type AgentWaiting = {
  readonly jobs: readonly {
    readonly id: string
    readonly description: string | null
    readonly command: string
    readonly since: number
    readonly until: number | null
  }[]
  readonly wake: { readonly at: number; readonly reason: string | null } | null
}

// How an agent's turn ended: `completed` or `failed` on its own, `interrupted` by the
// person (Escape, or a request they refused), or `unknown` when it only went idle, as an
// Escape shows in Antigravity. `reply` is the start of its last reply, one line of plain
// text; `at` tells this end from any other. `error` is a failed turn's error as its harness said it. `limit` is the
// usage-limit window the end ran into, with its length in minutes where known, and when it
// resets, in epoch milliseconds.
// `limited` is set where the end ran into a usage limit, whether or not the window is known.
// `files` are the absolute paths its edit tools wrote in the turn, first written first.
export type AgentTurnEnd = {
  readonly outcome: "completed" | "failed" | "interrupted" | "unknown"
  readonly reply?: string
  readonly error?: string
  readonly limit?: { readonly minutes: number | null; readonly resetsAt: number }
  readonly limited?: true
  readonly files?: readonly string[]
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
  // The model it runs and the reasoning effort it was set to, where its harness says.
  readonly model: string | null
  readonly effort: string | null
}

// What a terminal's process is doing. Exit and failure details replace each other.
// An exited process reports its code, or the signal that killed it, and the cause where
// the platform said, as being killed for memory. A running agent that reports through
// its hooks adds what it is doing.
export type TerminalStatus =
  | { readonly state: "starting" | "idle" | "finished" }
  | { readonly state: "running"; readonly agent?: AgentStatus }
  | {
      readonly state: "exited"
      readonly exitCode: number | null
      readonly signal: string | null
      readonly cause?: "out-of-memory"
    }
  | { readonly state: "failed"; readonly message: string }

// Who a terminal's name is from: the person, an agent (by its terminal's handle), the
// murmur, or the backend's default.
export type TitleSource =
  | { readonly kind: "person" }
  | { readonly kind: "agent"; readonly by: string }
  | { readonly kind: "murmur" }
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
  // The handle agents message it by, such as `moth`, where its backend has one.
  handle?: string
  // The handle of the terminal whose agent leads it, as its backend last said; null once
  // that ended. Whether the lead runs is the roster's to say.
  ledBy?: string | null
  // The handle of the terminal whose agent opened it, for an agent, a command or a plain
  // shell; null where the person opened it.
  openedBy?: string | null
  // Whether an agent has run in it since it opened, running now or since exited.
  agentRan?: boolean
  // Who its name is from, where its backend tells.
  titleSource?: TitleSource
  // Never present: a window has one, which tells tiles apart (see `isWindow`).
  itemId?: never
} & TerminalStatus

export type CanvasLayout = {
  viewport?: { x: number; y: number; zoom: number }
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

// A window holding one companion item, as its backend keeps it: which item it shows, and
// its name, the person's or the backend's default. It is an item undocked from a bar, or
// the session's project window, the one the person opens files in, which never docks
// (`home`). It sits in the session beside the terminals, so the sidebar and every view
// treat it as one, but it runs nothing.
export type CompanionWindowMeta = {
  readonly id: string
  readonly home: "undocked" | "project"
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
  // Grid's width presets; Canvas windows keep whatever size they were given.
  readonly sizePresets: { readonly grid: Record<string, SizePreset> }
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
  readonly items: readonly Item[]
  // Each terminal's bar as the person arranged it, by terminal id.
  readonly bars: Readonly<Record<string, Bar>>
  // Items shown again or anew since the person last looked; never saved.
  readonly fresh: Readonly<Record<ItemId, true>>
}
export type WorkspaceSession = {
  id: string
  name: string
  // When the person last had it open; null until they first do.
  visitedAt: number | null
  state: WorkspaceState
}
export type WorkspaceProject = Project & { activeSessionId: string; history: WorkspaceSession[] }
export type Workspace = { projects: WorkspaceProject[]; activeProjectId: string }
export type WorkspaceTarget = { projectId: string; workspaceSessionId: string }

// A terminal in a workspace session: what a backend and the UI name one by.
export type TerminalKey = WorkspaceTarget & { readonly terminalId: string }
