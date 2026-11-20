import type { BarKey } from "@novadeck/core/items/companion-bar"
import type { Backend } from "@novadeck/core/port"
import type { Store } from "@novadeck/core/store"
import type { SidebarPanel, ViewMode, Workspace } from "@novadeck/core/types"

import type { TourEffects } from "./start"

/**
 * What the tour needs of the app it runs in: the backend's tour and what its signals read, the
 * workspace, and the app's own commands that move the view, as the person's would. The app hands
 * it over once, at the tour's provider; the tour reaches nothing else of it.
 */
export type TourHost = {
  readonly backend: Pick<Backend, "tour" | "agents" | "messages" | "inbox">
  readonly workspace: Store<Workspace>
  readonly commands: TourCommands
}

export type TourCommands = Pick<TourEffects, "openTour" | "add"> & {
  readonly changeView: (next: ViewMode) => void
  // Brings a terminal into view and selects it (in Canvas the camera flies to it), with a
  // sidebar panel opened where one is named.
  readonly reveal: (terminalId: string, panel?: SidebarPanel) => void
  // Brings back a terminal of another project, switching to it.
  readonly revealTerminal: (terminalId: string, projectId: string) => void
  // Opens a tab of a terminal's side pane by its item key.
  readonly openBarTab: (terminalId: string, key: BarKey) => void
  readonly showInbox: () => void
  // Frames every window (Canvas).
  readonly frameAll: () => void
}
