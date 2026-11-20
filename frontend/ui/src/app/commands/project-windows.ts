import type { Workspace } from "@novadeck/core/types"

import { projectWindowsOn, shownElsewhere } from "../selectors"
import type { CommandContext } from "./context"

// How long a place handed to this window waits for a terminal this window hasn't heard of
// yet, as one an agent just opened that the runner is still telling it about.
export const arrivalWaitMs = 3_000

// The project holding the terminal, wherever it is.
export const projectOf = (workspace: Workspace, terminalId: string): string | undefined =>
  workspace.projects.find((project) =>
    project.history.some((session) =>
      session.state.roster.terminals.some((terminal) => terminal.id === terminalId),
    ),
  )?.id

export type ProjectWindowCommands = {
  // Whether project windows are on in this window.
  readonly windowsOn: () => boolean
  // Whether another window shows the project, with project windows on.
  readonly shownElsewhere: (projectId: string) => boolean
  // Opens the project in a new window, or brings forward the window that shows it.
  readonly openInNewWindow: (projectId: string) => void
  // Hands the terminal, and the Inbox row for it if one is named, to the window that shows its
  // project, which comes forward, or to this window when none does; with project windows on.
  // False, with nothing done, when they are off or the terminal's project is unknown.
  readonly handOffTerminal: (terminalId: string, rowId?: string) => boolean
  // The same for an Inbox row, but only when another window shows its project: the window it
  // is listed in opens it otherwise.
  readonly handOffRow: (row: { readonly id: string; readonly terminalId: string }) => boolean
  // Tells the window to swap projects with the window that shows `projectId`, before this one
  // switches to it. Does nothing where no other window shows it.
  readonly swapWith: (projectId: string) => void
}

// What project windows ask of the workspace: the commands for the context menu, the swap and
// the hand-offs. `switchHere` and `revealHere` are this window's own moves, which the routing
// rules in `workspace.ts` wrap.
export const createProjectWindowCommands = (ctx: CommandContext): ProjectWindowCommands => {
  const { workspace, ui, windows } = ctx
  const on = (): boolean => projectWindowsOn(ui.getSnapshot(), windows)
  return {
    windowsOn: on,
    shownElsewhere: (projectId) => shownElsewhere(ui.getSnapshot(), windows, projectId),
    openInNewWindow: (projectId) => {
      if (on()) windows?.open(projectId)
    },
    handOffTerminal: (terminalId, rowId) => {
      if (!windows || !on()) return false
      const projectId = projectOf(workspace.getSnapshot(), terminalId)
      if (projectId === undefined) return false
      windows.handOff({ projectId, terminalId, ...(rowId !== undefined && { rowId }) })
      return true
    },
    handOffRow: ({ id, terminalId }) => {
      if (!windows) return false
      const projectId = projectOf(workspace.getSnapshot(), terminalId)
      if (projectId === undefined || !shownElsewhere(ui.getSnapshot(), windows, projectId))
        return false
      windows.handOff({ projectId, terminalId, rowId: id })
      return true
    },
    swapWith: (projectId) => {
      if (windows && shownElsewhere(ui.getSnapshot(), windows, projectId)) windows.swap(projectId)
    },
  }
}
