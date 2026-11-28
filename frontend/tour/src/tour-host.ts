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
  readonly backend: Pick<
    Backend,
    "tour" | "nova" | "agents" | "messages" | "inbox" | "works" | "approvals"
  >
  readonly workspace: Store<Workspace>
  readonly commands: TourCommands
}

export type TourCommands = Pick<TourEffects, "add"> & {
  // Opens a folder as a new project by that name, on screen, in place of the projects of
  // `replaces`, those the backend removed.
  readonly openProjectInPlace: (opening: {
    readonly name: string
    readonly directory: string
    readonly replaces: readonly string[]
  }) => void
  readonly changeView: (next: ViewMode) => void
  // Brings a terminal of the session on screen into view for a look and selects it, leaving the
  // sidebar as it is: in Canvas the camera moves only where its window isn't on screen at a size
  // to read, out to every window first and then in to it.
  readonly travel: (terminalId: string) => void
  // Brings back a terminal of another project, switching to it.
  readonly revealTerminal: (terminalId: string, projectId: string) => void
  // Opens a tab of a terminal's side pane by its item id, or `messages`.
  readonly openBarTab: (terminalId: string, key: BarKey) => void
  // Shows a sidebar panel, as its rail button would: only where the person asks ("Show me") and
  // the rail is hidden, as in Zen.
  readonly showPanel: (panel: SidebarPanel) => void
  // Frames every window (Canvas).
  readonly frameAll: () => void
}
