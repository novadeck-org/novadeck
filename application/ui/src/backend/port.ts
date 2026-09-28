import type { ComponentType, ReactNode } from "react"

import type { WorkspaceSeed } from "../model/seed"
import type { WorkspaceAction } from "../model/state"
import type { Store } from "../model/store"
import type { TerminalMetadata, Workspace, WorkspaceTarget } from "../model/types"

// The UI-owned contract every terminal backend implements. Only app/ talks to it.

export type TerminalKey = WorkspaceTarget & { readonly terminalId: string }

// What a terminal's content area receives. The surface renders one content element and
// hands it to `renderWindow`; the window around it is the UI's to choose.
//
// The rest of the UI relies on this markup from the surface:
// - Its root carries `data-terminal-content` (view transitions morph it) and the
//   `terminal-content` class (layout and canvas styles size and fade it).
// - Its root carries `nodrag nopan`, so Canvas does not drag or pan from the content,
//   and stops `wheel` propagation without Ctrl/Meta, so scrolling output does not
//   zoom the canvas while pinch and Ctrl+wheel still do.
// - It sets `hidden={minimized && !clipContent}`, `aria-hidden` and `inert` from
//   `minimized`; Grid keeps a minimizing surface painted while its height animates.
// - The element that takes typed input carries `data-terminal-input`, so shortcuts
//   treat it as terminal input and search returns focus to it.
// - Its own styles may key off the frame's `terminal-compact` (Grid and Canvas) and
//   `terminal-focused` (Focus) classes; ship them with the adapter.
// Attach to a running terminal from the surface's effects; `commit` handles lifecycle.
export type TerminalSurfaceProps = {
  // Wraps the content in the terminal's window and the body its program calls for;
  // render what it returns. The surface keeps its controller and emulator mounted above
  // it: a different body remounts the content element, which must not restart the
  // session or its emulator.
  readonly renderWindow: (content: ReactNode) => ReactNode
  // Stable for the terminal's lifetime, so it is safe in effect dependencies.
  readonly terminalKey: TerminalKey
  readonly terminal: TerminalMetadata
  readonly projectName: string
  // The terminal font size from Preferences, in CSS pixels.
  readonly fontSize: number
  // Undefined when the layout offers no minimize control (Focus).
  readonly minimized?: boolean | undefined
  readonly clipContent?: boolean | undefined
  // True while keyboard navigation asks the surface to focus its input.
  readonly focusInput: boolean
  // Stable across renders; call it after focusing the input.
  readonly onInputFocused: () => void
}

// Workspace changes a backend reports on its own, such as a process exiting, a program
// taking over the foreground, or a shell that ended cleanly closing its terminal.
export type BackendAction = Extract<
  WorkspaceAction,
  { type: "terminal/status" | "terminal/process" | "terminal/close" }
>

export type BackendSink = {
  // Commits the actions as one store transaction, like a UI command. Actions for a
  // project, session or terminal that no longer exists are no-ops, and calls after
  // stop are ignored. Never call it from inside `commit`; the store throws.
  readonly dispatch: (actions: readonly BackendAction[]) => void
}

export type Backend = {
  // The workspace to start from, available before the app first renders. It needs at
  // least one project, each with at least one session; mounting throws otherwise.
  readonly seed: WorkspaceSeed
  // Allocates a terminal synchronously so commands can select and rename it at once.
  readonly newTerminal: (input: { number: number; directory: string }) => TerminalMetadata
  // Called inside every workspace store commit, before listeners, and once with []
  // for the initial workspace. That initial call runs during a render (a useState
  // initializer), possibly on an instance StrictMode then discards, so it must be
  // synchronous bookkeeping with no I/O. Later commits come from event handlers and
  // effects on the kept store; they stay synchronous but may start fire-and-forget
  // I/O, such as ending the process of a closed terminal that no view shows. Make
  // that I/O safe to repeat for the same terminal.
  readonly commit: (workspace: Workspace, actions: readonly WorkspaceAction[]) => void
  // Created once per backend instance so its identity is stable across renders.
  readonly TerminalSurface: ComponentType<TerminalSurfaceProps>
  // Optional. Called from an effect after the app mounts, never on an instance
  // StrictMode discarded, with the sink for events the backend reports; returns stop.
  // StrictMode may start, stop and start the same instance again, so stop must undo
  // everything start began.
  readonly start?: (sink: BackendSink) => () => void
  // Optional. How the link to the far side is doing, for the footer. Updates may begin
  // only once `start` runs.
  readonly connection?: Store<BackendConnectionState>
  // Optional. Where the far side can keep crashing: the backend then stops restarting
  // terminals until the person asks it to try again.
  readonly crashLoop?: {
    // While the backend holds back, how many crashes it counted in the last minute;
    // 0 otherwise.
    readonly crashes: Store<number>
    // Starts over: the count clears and the terminals on screen that were lost or
    // failed start fresh shells.
    readonly retry: () => void
  }
  // Optional. How far the restored session is from ready, so the boot splash can stay
  // up until its terminals are attached. Absent means ready at once.
  readonly boot?: Store<BootProgress>
  // Optional. Whether each terminal's screen is kept on disk, to show again above its
  // fresh shell when it restores, and a way to change that. Absent where the backend
  // keeps none.
  readonly transcripts?: {
    readonly enabled: Store<boolean>
    readonly set: (enabled: boolean) => void
  }
  // Optional. The agents whose sessions resume after a restart once connected: each
  // connection installs a small plugin into the agent, and disconnecting removes it.
  // Absent where the backend cannot connect agents.
  readonly agents?: {
    readonly state: Store<readonly AgentConnection[]>
    // Connects or disconnects the agent; the state shows the change as it goes.
    readonly set: (agent: AgentId, connected: boolean) => void
    // Looks again at which agents are installed and connected.
    readonly refresh: () => void
    // Whether to offer connecting them when the app opens for the first time.
    readonly onboarding: Store<boolean>
    readonly finishOnboarding: () => void
  }
  // Optional. Asks the person for a folder to open as a project; null when cancelled.
  // Absent where the backend cannot offer one.
  readonly pickDirectory?: () => Promise<string | null>
  // Optional. The debug panel, where this launch offers it: it triggers the states
  // the backend can be in. See README "Debug panel".
  readonly DebugPanel?: ComponentType<DebugPanelProps>
}

export type AgentId = "claude" | "codex" | "agy"

// An agent the backend can connect, as the Preferences switches show it.
export type AgentConnection = {
  readonly agent: AgentId
  // Installed where the backend runs.
  readonly available: boolean
  readonly connected: boolean
  // A connect or disconnect is under way.
  readonly busy: boolean
  // Why the last change did not work, for the person.
  readonly error?: string
}

// What the debug panel may ask of the workspace.
export type DebugPanelProps = {
  // Adds a terminal to the current session and returns its key.
  readonly addTerminal: () => TerminalKey
  readonly startFresh: () => void
  readonly selected: () => TerminalKey | undefined
}

// "unavailable" means the backend gave up reconnecting.
export type BackendConnectionState = "connected" | "reconnecting" | "unavailable"

// Must be free of side effects: StrictMode may call it twice.
export type CreateBackend = () => Backend

// A backend reached asynchronously, such as a runner the app must connect to first.
export type BackendConnection = {
  // Pure, like any CreateBackend: the seed is already loaded.
  readonly createBackend: CreateBackend
  // Ends the link once the app unmounts. Safe to call more than once.
  readonly close: () => void
}

// Connects before the app first renders. Rejects with an Error carrying a
// `failure: ConnectFailure`, which the boot splash explains and acts on. Aborting the
// signal abandons the attempt; a connection resolved after that is closed by the
// caller. It reports "loading" once the far side answered and the workspace is listed.
export type ConnectBackend = (
  signal: AbortSignal,
  progress: (stage: "loading") => void,
) => Promise<BackendConnection>

// Why connecting failed, sorted by what the person can do about it: a transient
// failure retries on its own, a different version can only quit, and the rest wait
// for Retry. `message` is for people; `code` and `detail` are for a bug report.
export type ConnectFailure = {
  readonly kind: "transient" | "incompatible" | "unauthorized" | "unknown"
  readonly message: string
  readonly code: string
  readonly detail: string
}

// The restored session's terminals being attached: `done` once they all are, have
// failed, or the backend stopped waiting.
export type BootProgress = {
  readonly attached: number
  readonly total: number
  readonly done: boolean
}

// What app/backend.ts chooses: a backend ready at once, or one to connect to.
export type BackendSelection =
  | { readonly createBackend: CreateBackend }
  | {
      readonly connect: ConnectBackend
      // Where the debug panel is offered: changes when it asks for a fresh boot, which
      // the app then runs from the splash without reloading the page.
      readonly reboots?: Store<number>
    }
