import { descendantsOf, leadChain } from "@novadeck/core/derivations"
import { activeProject } from "@novadeck/core/state"
import type { Workspace } from "@novadeck/core/types"

import type { MoveAsk } from "../terminals/move-state"
import type { MoveQuestion } from "../terminals/MoveTeammateDialog"
import { currentContext, currentState } from "./selectors"

// The teammate's move the person is asked about, as the workspace holds it now: null once it
// has nothing to ask, as when the terminal left the session or no longer has a lead.
export const moveQuestionOf = (workspace: Workspace, ask: MoveAsk | null): MoveQuestion | null => {
  if (!ask || ask.context !== currentContext(workspace)) return null
  const terminal = currentState(workspace).roster.terminals.find(
    (each) => each.id === ask.terminalId,
  )
  const top = leadChain(workspace, ask.terminalId).at(-1)
  if (!terminal?.ledBy || top === undefined) return null
  const lead = currentState(workspace).roster.terminals.find((each) => each.id === terminal.ledBy)
  if (!lead?.handle) return null
  const { to } = ask
  const session =
    "fresh" in to
      ? "a new session"
      : (activeProject(workspace)!.history.find((each) => each.id === to.sessionId)?.name ??
        "another session")
  return {
    terminal,
    lead: lead.handle,
    session,
    team: 1 + descendantsOf(workspace, top).length,
  }
}

export const sameMoveQuestion = (a: MoveQuestion | null, b: MoveQuestion | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.terminal === b.terminal &&
    a.lead === b.lead &&
    a.session === b.session &&
    a.team === b.team)
