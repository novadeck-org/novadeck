import { projectFromSeed } from "@novadeck/core/seed"
import type { Workspace } from "@novadeck/core/types"

import { currentState, projectWindowsOn, shownElsewhere } from "../selectors"
import type { CommandContext } from "./context"

// How long a place handed to this window waits for a terminal this window hasn't heard of
// yet, as one an agent just opened that the runner is still telling it about.
export const arrivalWaitMs = 3_000

// How long a window that picked a project another window shows waits for that window to send
// what it changed there before reading the project from the runner.
export const swapSettleMs = 150

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
  // `quiet` is for what an agent did, which only goes there, never raising a window.
  // False, with nothing done, when they are off or the terminal's project is unknown.
  readonly handOffTerminal: (terminalId: string, rowId?: string, quiet?: boolean) => boolean
  // The same for an Inbox row, but only when another window shows its project: the window it
  // is listed in opens it otherwise.
  readonly handOffRow: (row: { readonly id: string; readonly terminalId: string }) => boolean
  // Reads the project from the runner again and puts it in place of this window's copy, which
  // another window may have changed since, a project this window never heard of joining it.
  // Does nothing where the backend can't, or the runner no longer has the project.
  readonly readProject: (projectId: string) => Promise<void>
  // Tells the window to swap projects with the window that shows `projectId`, before this one
  // switches to it. Does nothing where no other window shows it.
  readonly swapWith: (projectId: string) => void
}

// What project windows ask of the workspace: the commands for the context menu, the swap and
// the hand-offs. `switchHere` and `revealHere` are this window's own moves, which the routing
// rules in `workspace.ts` wrap.
export const createProjectWindowCommands = (ctx: CommandContext): ProjectWindowCommands => {
  const { workspace, ui, windows, syncProject } = ctx
  const on = (): boolean => projectWindowsOn(ui.getSnapshot(), windows)
  return {
    readProject: async (projectId) => {
      const seed = await syncProject?.(projectId).catch((error: unknown) => {
        console.error("Could not read the project again", error)
        return undefined
      })
      if (!seed) return
      const snapshot = workspace.getSnapshot()
      const { enabledViews } = ui.getSnapshot().preferences
      workspace.dispatch({
        type: "project/sync",
        project: projectFromSeed(seed, {
          view: enabledViews.includes("focus") ? "focus" : enabledViews[0]!,
          windowedView: currentState(snapshot).windowedView,
          now: ctx.effects.now(),
        }),
      })
    },
    windowsOn: on,
    shownElsewhere: (projectId) => shownElsewhere(ui.getSnapshot(), windows, projectId),
    openInNewWindow: (projectId) => {
      if (on()) windows?.open(projectId)
    },
    handOffTerminal: (terminalId, rowId, quiet = false) => {
      if (!windows || !on()) return false
      const projectId = projectOf(workspace.getSnapshot(), terminalId)
      if (projectId === undefined) return false
      windows.handOff({
        projectId,
        terminalId,
        ...(rowId !== undefined && { rowId }),
        ...(quiet && { quiet: true as const }),
      })
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
