import { projectFromSeed } from "@novadeck/core/seed"
import type { Workspace } from "@novadeck/core/types"

import { currentState, projectWindowsOn, shownElsewhere } from "../selectors"
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
  // Whether another window shows the project and this one does not, with project windows on:
  // what is about it goes there. A project this window shows is handled here, even when
  // another window shows it too.
  readonly shownElsewhere: (projectId: string) => boolean
  // Opens the project in a new window, whether this or another window shows it already.
  readonly openInNewWindow: (projectId: string) => void
  // Hands the terminal, and the Inbox entry for it if one is named, to this window when it shows
  // the project, else to the window showing it that was used last, which comes forward, else to
  // this window, which switches; with project windows on.
  // `quiet` is for what an agent did, which only goes there, never raising a window.
  // False, with nothing done, when they are off or the terminal's project is unknown.
  readonly handOffTerminal: (terminalId: string, rowId?: string, quiet?: boolean) => boolean
  // The same for an Inbox entry, but only when another window shows its project and this one
  // does not: the window it is listed in opens it otherwise.
  readonly handOffEntry: (entry: { readonly id: string; readonly terminalId: string }) => boolean
  // Reads the project from the runner again and puts it in place of this window's copy, so the
  // sessions another window made or removed since are there, a project this window never heard
  // of joining it. What another window changed in a session it holds arrives live anyway.
  // Never the project this window shows: its copy is the live one, with edits yet to be saved.
  // Does nothing where the backend can't, or the runner no longer has the project; a project
  // that can't be read or built is logged, and the window carries on with what it has.
  readonly readProject: (projectId: string) => Promise<void>
}

// What project windows ask of the workspace: the commands for the context menu and the
// hand-offs. `switchHere` and `revealHere` are this window's own moves, which the routing
// rules in `workspace.ts` wrap.
export const createProjectWindowCommands = (ctx: CommandContext): ProjectWindowCommands => {
  const { workspace, ui, windows, syncProject } = ctx
  const on = (): boolean => projectWindowsOn(ui.getSnapshot(), windows)
  const elsewhere = (projectId: string): boolean =>
    workspace.getSnapshot().activeProjectId !== projectId &&
    shownElsewhere(ui.getSnapshot(), windows, projectId)
  return {
    readProject: async (projectId) => {
      if (!syncProject || workspace.getSnapshot().activeProjectId === projectId) return
      try {
        const seed = await syncProject(projectId)
        // Shown meanwhile, it is the live copy now, whatever the runner said a moment ago.
        if (!seed || workspace.getSnapshot().activeProjectId === projectId) return
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
      } catch (error) {
        console.error("Could not read the project again", error)
      }
    },
    windowsOn: on,
    shownElsewhere: elsewhere,
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
    handOffEntry: ({ id, terminalId }) => {
      if (!windows) return false
      const projectId = projectOf(workspace.getSnapshot(), terminalId)
      if (projectId === undefined || !elsewhere(projectId)) return false
      windows.handOff({ projectId, terminalId, rowId: id })
      return true
    },
  }
}
