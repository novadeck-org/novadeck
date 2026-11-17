import { activeProject } from "@novadeck/core/state"
import type { WorkspaceSession } from "@novadeck/core/types"
import { memo, useMemo } from "react"

import { sessionGlance } from "../projects/session-marks"
import { SessionsPanel } from "../sidebar/SessionsPanel"
import { useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { useMoving } from "./move-to"
import { useSessionMarks } from "./useSessionMarks"

// A session as its row shows it: its name, when the person was last there, its terminals'
// names and how many run.
type SessionRow = {
  readonly id: string
  readonly name: string
  readonly visitedAt: number | null
  readonly terminalNames: readonly string[]
  readonly running: number
}

const rowOf = (session: WorkspaceSession): SessionRow => {
  const { terminals } = session.state.roster
  return {
    id: session.id,
    name: session.name,
    visitedAt: session.visitedAt,
    terminalNames: terminals.map((terminal) => terminal.name),
    running: terminals.filter((terminal) => terminal.state === "running").length,
  }
}

const sameRow = (a: SessionRow, b: SessionRow): boolean =>
  a.id === b.id &&
  a.name === b.name &&
  a.visitedAt === b.visitedAt &&
  a.running === b.running &&
  a.terminalNames.length === b.terminalNames.length &&
  a.terminalNames.every((name, index) => name === b.terminalNames[index])

const sameRows = (a: readonly SessionRow[], b: readonly SessionRow[]): boolean =>
  a.length === b.length && a.every((row, index) => sameRow(row, b[index]!))

// The Sessions panel's list, wired to the workspace. It reads the sessions' marks itself, which
// change as agents work, and only what its rows show of the sessions, so neither wakes the rest
// of the sidebar, which once drew every panel again for each agent starting or stopping.
export const SessionsSection = memo(
  ({
    workspaceSessionId,
    historyKept,
  }: {
    readonly workspaceSessionId: string
    readonly historyKept: boolean
  }): React.JSX.Element => {
    const { commands } = useWorkspaceServices()
    const { switchSession, startFresh, renameSession, moveSession, removeSession } = commands
    const rows = useWorkspaceState(
      (workspace) => activeProject(workspace)!.history.map(rowOf),
      sameRows,
    )
    const marks = useSessionMarks()
    const moving = useMoving()
    const sessions = useMemo(
      () =>
        rows.map((row) => ({
          ...row,
          terminalNames: [...row.terminalNames],
          mark: sessionGlance(marks[row.id]),
        })),
      [rows, marks],
    )
    return (
      <SessionsPanel
        sessions={sessions}
        activeId={workspaceSessionId}
        onSelect={switchSession}
        onFresh={startFresh}
        onRename={renameSession}
        onMove={moveSession}
        onRemove={removeSession}
        historyKept={historyKept}
        moving={moving}
      />
    )
  },
)
