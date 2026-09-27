import { sessionName } from "../../model/session-name"
import { createTerminalState, createWorkspaceSession } from "../../model/state"
import type { ViewMode, WindowedView, WorkspaceSession } from "../../model/types"

// A fresh, empty workspace session named after the minute it started.
export const newWorkspaceSession = (
  { view, windowedView }: { view: ViewMode; windowedView: WindowedView },
  { id, now }: { id: string; now: number },
): WorkspaceSession =>
  createWorkspaceSession(
    { name: sessionName(now), state: createTerminalState([], view, windowedView) },
    { id, now },
  )
