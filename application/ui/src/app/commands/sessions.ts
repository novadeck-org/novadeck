import { sessionName } from "../../model/session-name"
import { createTerminalState, createWorkspaceSession } from "../../model/state"
import type { Project, ViewMode, WindowedView, WorkspaceSession } from "../../model/types"

// A fresh, empty workspace session named after the minute it started.
export const newWorkspaceSession = (
  { view, windowedView }: { view: ViewMode; windowedView: WindowedView },
  { id, now }: { id: string; now: number },
): WorkspaceSession =>
  createWorkspaceSession(
    { name: sessionName(now), state: createTerminalState([], view, windowedView) },
    { id, now },
  )

// The last segment of a POSIX or Windows path, ignoring trailing separators.
export const folderName = (directory: string): string => {
  const trimmed = directory.replace(/[\\/]+$/, "")
  return trimmed.split(/[\\/]/).at(-1) || directory
}

// A project for a folder the person picked, named after it.
export const folderProject = (directory: string, id: string): Project => ({
  id,
  name: folderName(directory),
  directory,
})
