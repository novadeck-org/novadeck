import type { Backend } from "../../backend/port"
import type { CanvasHandle } from "../../layouts/canvas/types"
import type { WorkspaceStore } from "../../model/store"
import type { SidebarPanel } from "../../shell/shell-state"
import type { WorkspaceNavigator } from "../routing"
import type { UiStore } from "../ui-store"

// Enough of an element, such as the button that opened the switcher, to give it
// focus back later.
export type FocusTarget = {
  readonly isConnected: boolean
  readonly focus: (options?: FocusOptions) => void
}

// Everything a command does outside the stores. app/controller/effects.ts supplies
// the DOM versions; tests pass their own.
export type CommandEffects = {
  // Runs `update` inside a view transition that follows the terminal, when motion allows.
  readonly transitionTerminal: (id: string, update: () => void) => void
  readonly cancelTransition: () => void
  readonly focusSidebarToggle: (panel: SidebarPanel) => void
  readonly focusZenCreate: () => void
  readonly focusZenEnter: () => void
  readonly focusWorkspaceViewport: () => void
  readonly focusTerminalTab: (id: string) => void
  // Focuses the element again if it is still on the page.
  readonly refocus: (element: FocusTarget) => void
  readonly afterFrame: (run: () => void) => void
  readonly afterMicrotask: (run: () => void) => void
  // Runs `run` after `ms` milliseconds; returns the cancel.
  readonly after: (ms: number, run: () => void) => () => void
  // Wide enough for the resizable sidebar instead of the phone drawer.
  readonly desktop: () => boolean
  readonly now: () => number
  readonly newId: () => string
}

export type CommandContext = {
  readonly workspace: WorkspaceStore
  readonly ui: UiStore
  readonly navigation: WorkspaceNavigator
  readonly newTerminal: Backend["newTerminal"]
  readonly pickDirectory?: Backend["pickDirectory"] | undefined
  readonly crashLoop?: Backend["crashLoop"] | undefined
  readonly canvas: { readonly current: CanvasHandle | null }
  readonly effects: CommandEffects
}
