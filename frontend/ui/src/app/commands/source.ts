import { addCompactGridTerminal } from "@novadeck/core/layout/grid-placement"
import { tilesOf } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"

import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"

export type SourceCommands = {
  // Opens a file of the active project, by its path from the project's root, in the
  // session's project window: re-pointed to it when it is open, made when it is not, and
  // selected, with or without a terminal. Nothing happens where the backend can't open
  // files there. Rejects when the backend can't open the file.
  readonly openSourceFile: (path: string) => Promise<void>
}

export type SourceDependencies = {
  readonly markCreated: (created: { readonly context: string; readonly id: string }) => void
  readonly pulse: () => void
}

// The path of a file from a project's directory, in the separator the directory is written in.
export const absolutePath = (directory: string, path: string): string => {
  const windows = directory.includes("\\") && !directory.includes("/")
  const base = directory.replace(/[\\/]+$/, "")
  return windows ? `${base}\\${path.replaceAll("/", "\\")}` : `${base}/${path}`
}

export const createSourceCommands = (
  { workspace, ui, navigation, effects, companions }: CommandContext,
  { markCreated, pulse }: SourceDependencies,
): SourceCommands => ({
  openSourceFile: async (path) => {
    const open = companions?.openInProject
    if (!open) return
    const before = workspace.getSnapshot()
    const target = currentTarget(before)
    const { item, window } = await open(
      target,
      absolutePath(activeProject(before)!.directory, path),
      effects.newId(),
    )
    // The person may have moved on while the backend read the file. The window belongs to the
    // session it was opened for: it goes there, and only if they are still in it is it
    // selected, placed beside what they have selected, and pulsed.
    const snapshot = workspace.getSnapshot()
    const now = currentTarget(snapshot)
    if (
      now.projectId !== target.projectId ||
      now.workspaceSessionId !== target.workspaceSessionId
    ) {
      workspace.dispatch({
        type: "project/open",
        target,
        item,
        window,
        canvasSize: ui.getSnapshot().canvasWindowSize,
      })
      return
    }
    const { roster, layout } = currentState(snapshot)
    const placed = roster.windows.some((each) => each.id === window.id)
    // A new window goes where an undocked one would: beside the selected tile, compactly.
    const grid = placed ? undefined : addCompactGridTerminal(tilesOf(roster), layout.grid, window)
    if (!placed) markCreated({ context: currentContext(snapshot), id: window.id })
    // The person stays in the panel they opened it from.
    navigation.navigateWorkspace([
      {
        type: "project/open",
        target,
        item,
        window,
        ...(grid ? { gridLayouts: grid } : {}),
        canvasSize: ui.getSnapshot().canvasWindowSize,
      },
    ])
    pulse()
  },
})
