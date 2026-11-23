import { descendantsOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { Tile, WorkspaceSession } from "@novadeck/core/types"
import { createContext, useContext, useMemo, type ReactNode } from "react"

import type { SessionsMove } from "../sidebar/SessionsPanel"
import { moveSessions } from "../terminals/move-state"
import type { MoveTo } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget } from "./selectors"
import { useSessionMarks } from "./useSessionMarks"

// How many sessions a terminal's menu lists before "All sessions…".
export const moveMenuSessions = 8

// A session as a move's menu shows it: its name, how many terminals it has and when the person
// was last there. The mark its terminals make is read by the menu's own row (SessionMark).
type MoveSession = {
  readonly id: string
  readonly name: string
  readonly count: number
  readonly visitedAt: number | null
}

const MoveSessionsContext = createContext<readonly MoveSession[]>([])

// Only what a move's menu shows of the open project's sessions.
const sameSessions = (a: readonly WorkspaceSession[], b: readonly WorkspaceSession[]): boolean =>
  a.length === b.length &&
  a.every((session, index) => {
    const other = b[index]!
    return (
      session.id === other.id &&
      session.name === other.name &&
      session.visitedAt === other.visitedAt &&
      session.state.roster.terminals.length === other.state.roster.terminals.length
    )
  })

// The open project's sessions for every terminal's menu, read once for them all. Every tab and
// window header reads it, so it holds nothing that changes as agents work: their marks are
// read by the menu's rows (SessionMark), which exist only while a menu is open. With them in
// here, each agent starting or stopping drew every tab and window again.
export const MoveSessionsProvider = ({
  children,
}: {
  readonly children: ReactNode
}): React.JSX.Element => {
  const sessions = useWorkspaceState((workspace) => activeProject(workspace)!.history, sameSessions)
  const value = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.id,
        name: session.name,
        count: session.state.roster.terminals.length,
        visitedAt: session.visitedAt,
      })),
    [sessions],
  )
  return <MoveSessionsContext.Provider value={value}>{children}</MoveSessionsContext.Provider>
}

// The mark a session's terminals make, in a move's menu.
const SessionMark = ({ id }: { readonly id: string }): React.JSX.Element | null => {
  const status = useSessionMarks()[id]?.status
  if (!status) return null
  return (
    <span
      className="session-status flex shrink-0 items-center"
      data-project-status={status}
      aria-hidden="true"
    >
      <span className="project-status-mark" />
    </span>
  )
}

// What a terminal's menu offers to move it: only a terminal, not a window, on a backend that
// moves terminals, once its shell has started or ended. Undefined for anything else.
export const useMoveTo = (tile: Tile): MoveTo | undefined => {
  const { backend, commands } = useWorkspaceServices()
  const sessions = useContext(MoveSessionsContext)
  const here = useWorkspaceState((workspace) => currentTarget(workspace).workspaceSessionId)
  const team = useWorkspaceState((workspace) => descendantsOf(workspace, tile.id).length)
  const movable = Boolean(backend.moveTerminal) && !isWindow(tile) && tile.state !== "starting"
  const { id } = tile
  const { moveTerminal, pickSession } = commands
  // The same menu entry while nothing it shows changes, so a tab isn't drawn again for it, as
  // during a drag.
  return useMemo(() => {
    if (!movable) return undefined
    const others = moveSessions(sessions, here)
    return {
      sessions: others.slice(0, moveMenuSessions).map((session) => ({
        id: session.id,
        name: session.name,
        count: session.count,
        mark: <SessionMark id={session.id} />,
      })),
      more: others.length > moveMenuSessions,
      team,
      onMove: (to) => moveTerminal(id, to),
      onPick: () => pickSession(id),
    }
  }, [movable, sessions, here, team, id, moveTerminal, pickSession])
}

// The terminal on its way to another session, as the Sessions panel shows it while the person
// picks where: undefined while none is.
export const useMoving = (): SessionsMove | undefined => {
  const { commands } = useWorkspaceServices()
  const moving = useUiState((state) => state.moving)
  const name = useWorkspaceState((workspace) =>
    moving && moving.context === currentContext(workspace)
      ? currentState(workspace).roster.terminals.find((each) => each.id === moving.terminalId)?.name
      : undefined,
  )
  const { moveTerminal, cancelPick } = commands
  return useMemo(() => {
    if (!moving || name === undefined) return undefined
    const { terminalId } = moving
    return {
      name,
      onPick: (sessionId: string) => moveTerminal(terminalId, { sessionId }),
      onCreate: () => moveTerminal(terminalId, { fresh: true }),
      onCancel: cancelPick,
    }
  }, [moving, name, moveTerminal, cancelPick])
}
