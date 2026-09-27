import type { ComponentType } from "react"

import type { WorkspaceSeed } from "../model/seed"
import type { WorkspaceAction } from "../model/state"
import type { TerminalMetadata, Workspace, WorkspaceTarget } from "../model/types"

// The UI-owned contract every terminal backend implements. Only app/ talks to it.

export type TerminalKey = WorkspaceTarget & { readonly terminalId: string }

// What a terminal's content area receives; the frame around it stays in terminals/.
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
  // Stable for the terminal's lifetime, so it is safe in effect dependencies.
  readonly terminalKey: TerminalKey
  readonly terminal: TerminalMetadata
  readonly projectName: string
  // Undefined when the layout offers no minimize control (Focus).
  readonly minimized?: boolean | undefined
  readonly clipContent?: boolean | undefined
  // True while keyboard navigation asks the surface to focus its input.
  readonly focusInput: boolean
  // Stable across renders; call it after focusing the input.
  readonly onInputFocused: () => void
}

// Workspace changes a backend reports on its own, such as a process exiting.
export type BackendAction = Extract<WorkspaceAction, { type: "terminal/status" }>

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
}

// Must be free of side effects: StrictMode may call it twice.
export type CreateBackend = () => Backend
