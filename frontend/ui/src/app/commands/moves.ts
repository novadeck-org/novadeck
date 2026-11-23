import { leadChain } from "@novadeck/core/derivations"
import { activeProject } from "@novadeck/core/state"
import type { Workspace } from "@novadeck/core/types"

import { freshSessionName, type MoveNotice, type MoveTarget } from "../../terminals/move-state"
import { currentContext, currentState, currentTarget } from "../selectors"
import type { CommandContext } from "./context"
import { newWorkspaceSession } from "./sessions"

export type MoveCommands = {
  // Moves a terminal of the session on screen to another session of its project, or to a new
  // one named after it. A teammate asks first whether it goes alone or with its team; a lead
  // always takes its team. The person stays where they are; a toast says where it went.
  readonly moveTerminal: (terminalId: string, to: MoveTarget) => void
  // Answers the teammate's question: alone, out of its lead's team, or the whole team, which
  // moves the lead at its top.
  readonly confirmMove: (scope: "alone" | "team") => void
  readonly cancelMove: () => void
  // Shows the Sessions panel to pick where the terminal goes, from its menu. Picking a session
  // moves it.
  readonly pickSession: (terminalId: string) => void
  // Ends the pick, leaving the sidebar as the person had it before.
  readonly cancelPick: () => void
  // Takes a move back, its handles and the lead it left included.
  readonly undoMove: (notice: MoveNotice) => void
  // Goes to the session a terminal moved to, selecting it there.
  readonly goToMoved: (notice: MoveNotice) => void
}

type MoveDependencies = {
  readonly peek: (panel: "sessions") => (() => void) | undefined
  readonly revealTerminal: (terminalId: string, projectId: string) => void
}

const reason = (error: unknown): string =>
  error instanceof Error && error.message ? error.message : "Something went wrong."

const sessionName = (workspace: Workspace, projectId: string, id: string): string =>
  workspace.projects
    .find((project) => project.id === projectId)
    ?.history.find((session) => session.id === id)?.name ?? "another session"

export const createMoveCommands = (
  { workspace, ui, moveTerminal: move, effects }: CommandContext,
  { peek, revealTerminal }: MoveDependencies,
): MoveCommands => {
  const tell = (moved: MoveNotice): void => {
    ui.update((state) => ({ ...state, moved }))
  }
  // Puts the sidebar back as it was, for a pick from a menu that showed the Sessions panel.
  let putBack: (() => void) | undefined
  const endPick = (): void => {
    if (!ui.getSnapshot().moving) return
    ui.update((state) => ({ ...state, moving: null }))
    const back = putBack
    putBack = undefined
    back?.()
  }
  // Moves it now, to a session made for it first where it goes to a new one.
  const go = (terminalId: string, to: MoveTarget): void => {
    if (!move) return
    const snapshot = workspace.getSnapshot()
    const project = activeProject(snapshot)!
    const target = currentTarget(snapshot)
    const terminal = currentState(snapshot).roster.terminals.find((each) => each.id === terminalId)
    if (!terminal) return
    endPick()
    let sessionId: string
    if ("fresh" in to) {
      const made = newWorkspaceSession(currentState(snapshot), {
        id: effects.newId(),
        now: effects.now(),
      })
      const fresh = { ...made, name: freshSessionName(terminal.name, project.history) }
      workspace.dispatch({
        type: "session/add",
        projectId: project.id,
        session: fresh,
        activate: false,
      })
      sessionId = fresh.id
    } else sessionId = to.sessionId
    if (sessionId === target.workspaceSessionId) return
    const lead = currentState(snapshot).roster.terminals.find(
      (each) => each.id === terminal.ledBy,
    )?.handle
    const notice = {
      id: effects.newId(),
      projectId: project.id,
      terminalId,
      name: terminal.name,
      session: { id: sessionId, name: sessionName(workspace.getSnapshot(), project.id, sessionId) },
      fresh: "fresh" in to,
      from: target.workspaceSessionId,
      ...(lead !== undefined && { lead }),
    }
    move({ ...target, terminalId }, sessionId).then(
      (result) => tell({ ...notice, result }),
      (error: unknown) => {
        // A session made for a move that didn't happen goes again, unless it has gained something.
        if ("fresh" in to) removeIfEmpty(project.id, sessionId)
        tell({ ...notice, failed: reason(error) })
      },
    )
  }
  const removeIfEmpty = (projectId: string, workspaceSessionId: string): void => {
    const session = workspace
      .getSnapshot()
      .projects.find((each) => each.id === projectId)
      ?.history.find((each) => each.id === workspaceSessionId)
    const { terminals, windows } = session?.state.roster ?? {}
    if (!session || terminals?.length || windows?.length) return
    workspace.dispatch({
      type: "session/remove",
      projectId,
      workspaceSessionId,
      now: effects.now(),
    })
  }
  return {
    moveTerminal: (terminalId, to) => {
      const snapshot = workspace.getSnapshot()
      // A teammate asks first; a lead, or one on its own, goes.
      if (leadChain(snapshot, terminalId).length > 0)
        return void ui.update((state) => ({
          ...state,
          moveAsk: { context: currentContext(snapshot), terminalId, to },
        }))
      go(terminalId, to)
    },
    confirmMove: (scope) => {
      const pending = ui.getSnapshot().moveAsk
      if (!pending) return
      ui.update((state) => ({ ...state, moveAsk: null }))
      const snapshot = workspace.getSnapshot()
      if (pending.context !== currentContext(snapshot)) return
      const top = leadChain(snapshot, pending.terminalId).at(-1)
      go(scope === "team" && top !== undefined ? top : pending.terminalId, pending.to)
    },
    cancelMove: () => {
      ui.update((state) => (state.moveAsk ? { ...state, moveAsk: null } : state))
      endPick()
    },
    pickSession: (terminalId) => {
      const snapshot = workspace.getSnapshot()
      if (!move || !currentState(snapshot).roster.terminals.some((each) => each.id === terminalId))
        return
      // The panel shows first, as leaving it ends a pick.
      if (!ui.getSnapshot().moving) putBack = peek("sessions")
      effects.afterFrame(() => effects.focusMovePick())
      ui.update((state) => ({
        ...state,
        moving: { context: currentContext(snapshot), terminalId },
      }))
    },
    cancelPick: endPick,
    undoMove: (notice) => {
      const { result } = notice
      if (!move || !result) return
      ui.update((state) => (state.moved?.id === notice.id ? { ...state, moved: null } : state))
      const handles = Object.fromEntries(result.moved.map((each) => [each.terminalId, each.was]))
      void move(
        {
          projectId: notice.projectId,
          workspaceSessionId: result.sessionId,
          terminalId: notice.terminalId,
        },
        notice.from,
        { handles, ...(result.left ? { lead: result.left } : {}) },
      ).catch((error: unknown) =>
        tell({
          ...notice,
          id: effects.newId(),
          session: {
            id: notice.from,
            name: sessionName(workspace.getSnapshot(), notice.projectId, notice.from),
          },
          failed: reason(error),
          result: undefined,
        }),
      )
    },
    goToMoved: (notice) => {
      ui.update((state) => (state.moved?.id === notice.id ? { ...state, moved: null } : state))
      revealTerminal(notice.terminalId, notice.projectId)
    },
  }
}
