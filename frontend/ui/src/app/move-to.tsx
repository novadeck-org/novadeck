import { descendantsOf } from "@novadeck/core/derivations"
import { isWindow } from "@novadeck/core/roster"
import { activeProject } from "@novadeck/core/state"
import type { Tile, WorkspaceSession } from "@novadeck/core/types"
import { createContext, useContext, useMemo, useRef, type ReactNode } from "react"

import type { ProjectStatus } from "../projects/project-status"
import type { SessionsMove } from "../sidebar/SessionsPanel"
import { moveSessions, type MoveTarget } from "../terminals/move-state"
import type { TabsAway } from "../terminals/TerminalTabs"
import type { MoveTo } from "../terminals/window-menu"
import { useUiState, useWorkspaceServices, useWorkspaceState } from "./controller/context"
import { currentContext, currentState, currentTarget } from "./selectors"
import { useSessionMarks } from "./useSessionMarks"

// How many sessions a terminal's menu lists before "All sessions…".
export const moveMenuSessions = 8

// A session as a move's menu shows it: its name, how many terminals it has, when the person
// was last there and the mark its terminals make.
type MoveSession = {
  readonly id: string
  readonly name: string
  readonly count: number
  readonly visitedAt: number | null
  readonly status: ProjectStatus | undefined
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

// The open project's sessions for every terminal's menu, read once for them all, as each
// tab and header asking on its own would read the marks again per terminal.
export const MoveSessionsProvider = ({
  children,
}: {
  readonly children: ReactNode
}): React.JSX.Element => {
  const marks = useSessionMarks()
  const sessions = useWorkspaceState((workspace) => activeProject(workspace)!.history, sameSessions)
  const value = useMemo(
    () =>
      sessions.map((session) => ({
        id: session.id,
        name: session.name,
        count: session.state.roster.terminals.length,
        visitedAt: session.visitedAt,
        status: marks[session.id]?.status,
      })),
    [sessions, marks],
  )
  return <MoveSessionsContext.Provider value={value}>{children}</MoveSessionsContext.Provider>
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
    const others = moveSessions(sessions, here, Infinity)
    return {
      sessions: others.slice(0, moveMenuSessions).map((session) => ({
        id: session.id,
        name: session.name,
        count: session.count,
        mark: session.status && (
          <span
            className="session-status flex shrink-0 items-center"
            data-project-status={session.status}
            aria-hidden="true"
          >
            <span className="project-status-mark" />
          </span>
        ),
      })),
      more: others.length > moveMenuSessions,
      team,
      onMove: (to) => moveTerminal(id, to),
      onPick: () => pickSession(id, "menu"),
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
    const { terminalId, over } = moving
    return {
      name,
      over: over === null ? null : "fresh" in over ? "new" : over.sessionId,
      onPick: (sessionId: string) => moveTerminal(terminalId, { sessionId }),
      onCreate: () => moveTerminal(terminalId, { fresh: true }),
      onCancel: cancelPick,
    }
  }, [moving, name, moveTerminal, cancelPick])
}

// How long a dragged tab holds over a rail button before its panel opens.
export const springMs = 400

// The rail's buttons a dragged tab opens a panel by: the Sessions panel to drop it on a
// session, the Terminals panel to go back.
const springs = '[id="sessions-toggle"], [id="terminals-toggle"]'

// Where a terminal's tab dragged out of the list goes: held over the rail's Sessions button
// it opens the Sessions panel, and dropped on a session, or on the new session's button, it
// moves the terminal there. It travels anywhere in the workspace's body. Undefined where the
// backend can't move terminals.
export const useTabsAway = (): TabsAway | undefined => {
  const { backend, commands, ui, workspace } = useWorkspaceServices()
  // The rail button held over, and the timer that opens its panel.
  const held = useRef<{ readonly button: Element; readonly cancel: () => void } | null>(null)
  // The tab being dragged, and whether the person has pulled it out of the list. Until then it
  // reorders the list and nothing else; it becomes a pick only once it reaches Sessions.
  const dragged = useRef<{ readonly id: string; free: boolean } | null>(null)
  const { pickSession, overMove, moveTerminal, cancelPick, showSessions, showTerminals } = commands
  return useMemo(() => {
    if (!backend.moveTerminal) return undefined
    const letGo = (): void => {
      held.current?.button.removeAttribute("data-move-spring")
      held.current?.cancel()
      held.current = null
    }
    const spring = (button: Element | null): void => {
      if (button === held.current?.button) return
      letGo()
      if (!button) return
      button.setAttribute("data-move-spring", "")
      const timer = setTimeout(() => {
        if (button.id !== "sessions-toggle") return showTerminals()
        // The panel opens picking where the tab goes, so letting go anywhere else gives up.
        if (dragged.current && !ui.getSnapshot().moving) pickSession(dragged.current.id, "drag")
        showSessions()
      }, springMs)
      held.current = { button, cancel: () => clearTimeout(timer) }
    }
    return {
      bounds: () => document.querySelector(".workspace-body"),
      start: (terminalId) => {
        dragged.current = { id: terminalId, free: false }
      },
      pull: ({ free }) => {
        if (dragged.current) dragged.current.free = free
      },
      move: ({ x, y }) => {
        if (!dragged.current?.free) return
        const hits = document.elementsFromPoint(x, y)
        const find = (selector: string): Element | null =>
          hits.map((hit) => hit.closest(selector)).find((each) => each !== null) ?? null
        spring(find(springs))
        const { location, moving } = ui.getSnapshot()
        if (location.route.panel !== "sessions") return overMove(null)
        if (!moving) pickSession(dragged.current.id, "drag")
        if (find("[data-sessions-create]")) return overMove({ fresh: true })
        const id = find("[data-workspace-session]")?.getAttribute("data-workspace-session")
        const here = currentTarget(workspace.getSnapshot()).workspaceSessionId
        overMove(id && id !== here ? ({ sessionId: id } satisfies MoveTarget) : null)
      },
      end: (terminalId, canceled) => {
        letGo()
        dragged.current = null
        const { moving } = ui.getSnapshot()
        if (moving?.via !== "drag" || moving.terminalId !== terminalId) return false
        if (canceled || moving.over === null) {
          cancelPick()
          return false
        }
        moveTerminal(terminalId, moving.over)
        return true
      },
    }
  }, [
    backend.moveTerminal,
    ui,
    workspace,
    pickSession,
    overMove,
    moveTerminal,
    cancelPick,
    showSessions,
    showTerminals,
  ])
}
