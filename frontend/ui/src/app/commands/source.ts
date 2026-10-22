import { activeProject } from "@novadeck/core/state"
import type { Workspace, WorkspaceState, WorkspaceTarget } from "@novadeck/core/types"

import { currentContext, currentTarget } from "../selectors"
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

const sessionState = (workspace: Workspace, target: WorkspaceTarget): WorkspaceState | undefined =>
  workspace.projects
    .find((project) => project.id === target.projectId)
    ?.history.find((session) => session.id === target.workspaceSessionId)?.state

export const createSourceCommands = (
  { workspace, ui, navigation, effects, companions }: CommandContext,
  { markCreated, pulse }: SourceDependencies,
): SourceCommands => ({
  openSourceFile: async (path) => {
    const open = companions?.openInProject
    if (!open) return
    const before = workspace.getSnapshot()
    const target = currentTarget(before)
    const known = sessionState(before, target)?.roster.windows
    const had = known?.find((each) => each.home === "project")
    const { item, window } = await open(
      target,
      absolutePath(activeProject(before)!.directory, path),
      effects.newId(),
    )
    const snapshot = workspace.getSnapshot()
    const state = sessionState(snapshot, target)
    // The person closed the window meanwhile, and the backend's close, queued behind this
    // open, removes it again: it isn't brought back to be selected and removed.
    if (had && !state?.roster.windows.some((each) => each.id === had.id)) return
    // Made by this open, not by what the watch reported first: whichever came first, it is
    // placed the same.
    const made = !known?.some((each) => each.id === window.id)
    // The person may have moved on while the backend read the file. The window belongs to the
    // session it was opened for: it goes there, and only if they are still in it is it
    // selected, placed beside what they have selected, and pulsed.
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
        made,
        canvasSize: ui.getSnapshot().canvasWindowSize,
      })
      return
    }
    // A new window goes where an undocked one would: beside the selected tile, compactly.
    if (made) markCreated({ context: currentContext(snapshot), id: window.id })
    // The person stays in the panel they opened it from.
    navigation.navigateWorkspace([
      {
        type: "project/open",
        target,
        item,
        window,
        made,
        canvasSize: ui.getSnapshot().canvasWindowSize,
      },
    ])
    pulse()
  },
})
