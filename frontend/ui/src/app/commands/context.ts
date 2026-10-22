import type { Chat } from "@novadeck/chat/state"
import type { Rect } from "@novadeck/core/layout/spatial"
import type { Murmur } from "@novadeck/core/murmur"
import type { Backend } from "@novadeck/core/port"
import type { WorkspaceStore } from "@novadeck/core/store"
import type { SidebarPanel } from "@novadeck/core/types"
import type { ItemStore } from "@novadeck/items/state"

import type { CanvasHandle } from "../../layouts/canvas/types"
import type { Dictation } from "../../voice/dictation-control"
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
  // Focuses the panel's toggle after Zen's dock, where the person pressed, is gone.
  readonly focusSidebarToggleStranded: (panel: SidebarPanel) => void
  readonly focusZenCreate: () => void
  readonly focusZenEnter: () => void
  readonly focusWorkspaceViewport: () => void
  readonly focusTerminalTab: (id: string) => void
  // Focuses the terminal's input now; false when it has none that can take focus.
  readonly focusTerminalInput: (id: string) => boolean
  // Where each terminal and window the current view shows is on screen.
  readonly tileRects: () => readonly { readonly id: string; readonly rect: Rect }[]
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
  // What the chat keeps: drafts, replies, sends and the terminals answered in.
  readonly chat: Chat
  readonly pickDirectory?: Backend["pickDirectory"] | undefined
  readonly crashLoop?: Backend["crashLoop"] | undefined
  readonly resetTitle?: Backend["resetTitle"] | undefined
  // The agents' conversations, where the backend reads them, which the chat sends to.
  readonly conversations?: Backend["conversations"] | undefined
  // Where the backend's companions come from.
  readonly companions?: Backend["companions"] | undefined
  // The item store, where the backend has companions.
  readonly itemStore?: ItemStore | undefined
  readonly canvas: { readonly current: CanvasHandle | null }
  // Murmur, where the backend has it: the one-time offer is counted with it.
  readonly murmur?: Pick<Murmur, "noteOffered"> | undefined
  // Voice input, where the backend transcribes.
  readonly dictation?: Dictation | undefined
  readonly effects: CommandEffects
}
