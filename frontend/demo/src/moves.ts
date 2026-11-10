import type {
  Backend,
  BackendAction,
  BackendSink,
  TerminalMoveResult,
  TerminalMoveUndo,
} from "@novadeck/core/port"
import type { TerminalKey, TerminalMetadata, Workspace } from "@novadeck/core/types"

import { demoHandle } from "./handles"
import { sessionOf } from "./workspace"

// A terminal moved to another session of its project, as the runner moves one: a lead with
// its whole team, each lead before those it leads; a teammate on its own out of its lead's
// team. Each keeps its handle unless the session it goes to holds it already, then takes the
// first of the demo's words that's free there, and those it leads follow its new handle. An
// undo takes the handles they had back where they're free, and rejoins the lead it left.
// The actions move them; the result is what the backend answers. A move that can't happen
// says why.
export const demoMove = (
  workspace: Workspace | undefined,
  key: TerminalKey,
  sessionId: string,
  undo?: TerminalMoveUndo,
):
  | { readonly actions: readonly BackendAction[]; readonly result: TerminalMoveResult }
  | { readonly error: string } => {
  const from = sessionOf(workspace, key)?.state.roster.terminals ?? []
  const to = sessionOf(workspace, { ...key, workspaceSessionId: sessionId })?.state.roster.terminals
  const terminal = from.find((each) => each.id === key.terminalId)
  if (!terminal) return { error: "It's no longer in its session." }
  if (!to || sessionId === key.workspaceSessionId)
    return { error: "That session isn't one of its project's others." }
  // Its team, each lead before the terminals it leads.
  const team: TerminalMetadata[] = [terminal]
  for (let at = 0; at < team.length; at += 1) {
    const lead = team[at]!.handle
    if (!lead) continue
    for (const each of from)
      if (each.ledBy === lead && !team.includes(each) && each.id !== terminal.id) team.push(each)
  }
  const left = terminal.ledBy && from.some((each) => each.handle === terminal.ledBy)
  const taken = new Set(to.flatMap((each) => [each.handle, each.ledBy].filter(Boolean)))
  const renamed = new Map<string, string>()
  const moved = team.map((each) => {
    const want = undo?.handles[each.id] ?? each.handle
    let handle = want && !taken.has(want) ? want : undefined
    for (let number = 1; !handle; number += 1)
      if (!taken.has(demoHandle(number))) handle = demoHandle(number)
    taken.add(handle)
    if (each.handle) renamed.set(each.handle, handle)
    return { terminal: each, handle }
  })
  const rejoined = undo?.lead && to.some((each) => each.handle === undo.lead) ? undo.lead : null
  const actions = moved.map(({ terminal: each, handle }): BackendAction => {
    const ledBy =
      each === terminal
        ? left
          ? null
          : (rejoined ?? each.ledBy ?? null)
        : each.ledBy
          ? (renamed.get(each.ledBy) ?? each.ledBy)
          : null
    return {
      type: "terminal/move",
      projectId: key.projectId,
      from: key.workspaceSessionId,
      to: sessionId,
      terminal: { ...each, handle, ledBy },
    }
  })
  return {
    actions,
    result: {
      sessionId,
      moved: moved.map(({ terminal: each, handle }) => ({
        terminalId: each.id,
        handle,
        was: each.handle ?? handle,
      })),
      left: left ? terminal.ledBy! : null,
    },
  }
}

// A demo that moves terminals to another session of their project at once, as the runner
// would: it reads the workspace the app last committed, and tells the move through the sink
// the backend was started with.
export const withMoves = (backend: Backend): Backend => {
  let latest: Workspace | undefined
  let sink: BackendSink | undefined
  return {
    ...backend,
    commit: (workspace, actions) => {
      latest = workspace
      backend.commit(workspace, actions)
    },
    start: (next) => {
      sink = next
      const stop = backend.start?.(next)
      return () => {
        stop?.()
        if (sink === next) sink = undefined
      }
    },
    moveTerminal: (key, sessionId, undo) => {
      const made = demoMove(latest, key, sessionId, undo)
      if ("error" in made) return Promise.reject(new Error(made.error))
      sink?.dispatch(made.actions)
      return Promise.resolve(made.result)
    },
  }
}
