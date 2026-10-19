import type { Backend, BackendSink, TerminalKey } from "@novadeck/core/port"
import type { Workspace } from "@novadeck/core/types"
import type { UpdateOffer } from "@novadeck/core/update"
import type { DemoScreenStates } from "@novadeck/demo/runtime"
import type { ComponentType } from "react"

import type { DemoUpdates } from "./updates"

// The demo's debug layer, in two halves: the shell (startup, connection, crash loop, the
// panel itself and which demo runs) and the states a terminal, an agent or the page can
// be put in. The shell composes the backend and the panel; the states provide the parts
// below and the actions the panel lists.

// Which terminal an agent action acts on: the selected one; another of its session, added
// in the background where it has none, so the person looks elsewhere and gets the unread
// mark and notice; or the first live terminal of another project, for the switcher.
export const demoTargets = ["selected", "terminal", "project"] as const
export type DemoTarget = (typeof demoTargets)[number]

// What a state's action may use.
export type DemoActionContext = {
  // Where the group's agent actions land, as its switch chose; the others ignore it.
  readonly target: DemoTarget
  // The selected terminal of the session on screen, if any.
  readonly selected: () => TerminalKey | undefined
  // Adds a terminal to the current session and returns its key.
  readonly addTerminal: () => TerminalKey
  // Adds a terminal to the session holding `to` the way a background process would: it
  // is not selected and the sidebar stays on its panel. Returns its key.
  readonly addInBackground: (to: TerminalKey) => TerminalKey
  readonly startFresh: () => void
  // The backend's sink; undefined before start or after stop.
  readonly dispatch: BackendSink["dispatch"] | undefined
  // The workspace as last committed.
  readonly workspace: () => Workspace | undefined
  // A line for the panel's foot, as "Select a terminal first."
  readonly note: (text: string) => void
}

export type DemoAction = {
  // Short and unique within its group, as "Exit code 3".
  readonly label: string
  // What should appear once it runs, in a line, as "Ending bar with Restart".
  readonly hint: string
  // Boots the demo again to show it; the panel marks it so its hint needn't say so.
  readonly reboots?: true
  readonly run: (context: DemoActionContext) => void | Promise<void>
}

// Where a group sits in the panel, in this order: what the selected or a new terminal
// can be in, what its agent can be in, and the app around them.
export const demoSections = ["Terminals", "Agents", "App"] as const
export type DemoSection = (typeof demoSections)[number]

export type DemoActionGroup = {
  readonly section: DemoSection
  readonly title: string
  // Its actions act on a target, which the group lets the person choose.
  readonly targets?: true
  readonly actions: readonly DemoAction[]
}

// The states half: backend parts that replace or add to the plain demo's, and the
// panel's groups for terminals, agents, notices, updates and folders.
export type DemoStates = {
  readonly groups: readonly DemoActionGroup[]
  readonly agents: NonNullable<Backend["agents"]>
  // Opens the first-run dialog for connecting agents again.
  readonly openWelcome: () => void
  readonly notices: NonNullable<Backend["notices"]>
  readonly updates: NonNullable<Backend["updates"]>
  // Tells `updates`' listeners of a release, as the Update group's actions do.
  readonly offer: (offer: UpdateOffer) => void
  // What the Updates group plays an installed copy's updates with.
  readonly updateControls: DemoUpdates
  readonly pickDirectory: NonNullable<Backend["pickDirectory"]>
  // The demo's conversations, with what the panel arms for the chat's next send.
  readonly chat: (
    conversations: NonNullable<Backend["conversations"]>,
  ) => NonNullable<Backend["conversations"]>
  readonly screens: DemoScreenStates
  // Whether this paste of the terminal's fails, as the panel armed it for its next one.
  readonly failPaste: (key: TerminalKey) => boolean
  // A fresh shell in place of an ended one, through the backend's sink.
  readonly restart: (key: TerminalKey, dispatch: BackendSink["dispatch"]) => void
  // Always mounted while the demo runs: where `notices.show` puts its notifications.
  readonly Notices: ComponentType
}
