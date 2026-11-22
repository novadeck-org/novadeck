import { projectFromSeed } from "@novadeck/core/seed"
import type { Workspace } from "@novadeck/core/types"

import { currentState, projectWindowsOn, shownElsewhere } from "../selectors"
import type { CommandContext } from "./context"

// How long a place handed to this window waits for a terminal this window hasn't heard of
// yet, as one an agent just opened that the runner is still telling it about.
export const arrivalWaitMs = 3_000

// How long a window waits at most for its own saves to land before it asks the app for a swap.
export const swapFlushMs = 2_500

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
  // Hands the terminal, and the Inbox entry for it if one is named, to the window that shows its
  // project, which comes forward, or to this window when none does; with project windows on.
  // `quiet` is for what an agent did, which only goes there, never raising a window.
  // False, with nothing done, when they are off or the terminal's project is unknown.
  readonly handOffTerminal: (terminalId: string, rowId?: string, quiet?: boolean) => boolean
  // The same for an Inbox entry, but only when another window shows its project: the window it
  // is listed in opens it otherwise.
  readonly handOffEntry: (entry: { readonly id: string; readonly terminalId: string }) => boolean
  // Reads the project from the runner again and puts it in place of this window's copy, which
  // another window may have changed since, a project this window never heard of joining it.
  // Never the project this window shows: its copy is the live one, with edits yet to be saved.
  // Does nothing where the backend can't, or the runner no longer has the project; a project
  // that can't be read or built is logged, and the window carries on with what it has.
  readonly readProject: (projectId: string) => Promise<void>
  // Swaps projects with the window that shows `projectId`, before this one switches to it: this
  // window sends its saves first (within `swapFlushMs`), then the app has the other window send
  // its own before it answers, so the project may be read as soon as this resolves. False when
  // the app brought the other window forward instead, and this window stays where it is. True,
  // with nothing done, where no other window shows the project.
  readonly swapWith: (projectId: string) => Promise<boolean>
}

// What project windows ask of the workspace: the commands for the context menu, the swap and
// the hand-offs. `switchHere` and `revealHere` are this window's own moves, which the routing
// rules in `workspace.ts` wrap.
export const createProjectWindowCommands = (ctx: CommandContext): ProjectWindowCommands => {
  const { workspace, ui, windows, syncProject, settleSaves } = ctx
  const on = (): boolean => projectWindowsOn(ui.getSnapshot(), windows)
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
    handOffEntry: ({ id, terminalId }) => {
      if (!windows) return false
      const projectId = projectOf(workspace.getSnapshot(), terminalId)
      if (projectId === undefined || !shownElsewhere(ui.getSnapshot(), windows, projectId))
        return false
      windows.handOff({ projectId, terminalId, rowId: id })
      return true
    },
    swapWith: async (projectId) => {
      if (!windows || !shownElsewhere(ui.getSnapshot(), windows, projectId)) return true
      // What this window changed in its own project lands first, for the other to read.
      await new Promise<void>((resolve) => {
        const cancel = ctx.effects.after(swapFlushMs, resolve)
        void (settleSaves?.() ?? Promise.resolve()).then(
          () => (cancel(), resolve()),
          () => (cancel(), resolve()),
        )
      })
      return (await windows.swap(projectId)) !== "forwarded"
    },
  }
}
