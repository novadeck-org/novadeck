import { handleText } from "./handle"
import { remembered } from "./roster"
import { activeSession } from "./state"
import type { Workspace } from "./types"

// What the workspace alone says of its current session's terminals, for the views that
// name one terminal by another. They read no UI state.

// The current session's roster; the workspace always has one once seeded.
const rosterOf = (workspace: Workspace) => activeSession(workspace)!.state.roster

// How the current session's terminals are told apart where one says where another's
// work came from, by id: "@fox · Terminal", as names alone repeat.
const originsOf = remembered((roster): Readonly<Record<string, string>> =>
  Object.fromEntries(
    roster.terminals.map((each) => [
      each.id,
      each.handle ? `${handleText(each.handle)} · ${each.name}` : each.name,
    ]),
  ),
)

export const terminalOrigins = (workspace: Workspace): Readonly<Record<string, string>> =>
  originsOf(rosterOf(workspace))

type RunningLead = { readonly handle: string; readonly name: string }

// The leads of a roster's terminals that run, by terminal id: each lead's handle and
// name. A terminal whose lead is closed, exited or not yet started has none. Where
// several running terminals share a handle, the first one leads.
const leadsOf = remembered((roster): Readonly<Record<string, RunningLead>> => {
  const running = new Map<string, string>()
  for (const each of roster.terminals)
    if (
      each.handle !== undefined &&
      !running.has(each.handle) &&
      (each.state === "idle" || each.state === "running" || each.state === "finished")
    )
      running.set(each.handle, each.name)
  return Object.fromEntries(
    roster.terminals.flatMap((each) => {
      const name = each.ledBy ? running.get(each.ledBy) : undefined
      return each.ledBy && name !== undefined ? [[each.id, { handle: each.ledBy, name }]] : []
    }),
  )
})

// The leads of the current session's terminals that run, by terminal id.
export const runningLeads = (workspace: Workspace): Readonly<Record<string, RunningLead>> =>
  leadsOf(rosterOf(workspace))

// The current session's terminals' names, by handle, which name the agents its messages
// are with.
const namesOf = remembered((roster): Readonly<Record<string, string>> =>
  Object.fromEntries(
    roster.terminals.flatMap((each) => (each.handle ? [[each.handle, each.name]] : [])),
  ),
)

export const handleNames = (workspace: Workspace): Readonly<Record<string, string>> =>
  namesOf(rosterOf(workspace))
