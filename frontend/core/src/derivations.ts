import { handleText } from "./handle"
import { remembered } from "./roster"
import { activeSession } from "./state"
import type { TerminalMetadata, Workspace } from "./types"

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

// The terminals that can lead, by handle: the first live terminal with each handle. One
// closed, exited or not yet started leads no one.
const liveHandles = remembered((roster): ReadonlyMap<string, TerminalMetadata> => {
  const live = new Map<string, TerminalMetadata>()
  for (const each of roster.terminals)
    if (
      each.handle !== undefined &&
      !live.has(each.handle) &&
      (each.state === "idle" || each.state === "running" || each.state === "finished")
    )
      live.set(each.handle, each)
  return live
})

// The leads of a roster's terminals that run, by terminal id: each lead's handle and
// name. A terminal whose lead is closed, exited or not yet started has none. Where
// several running terminals share a handle, the first one leads.
const leadsOf = remembered((roster): Readonly<Record<string, RunningLead>> => {
  const live = liveHandles(roster)
  return Object.fromEntries(
    roster.terminals.flatMap((each) => {
      const lead = each.ledBy ? live.get(each.ledBy) : undefined
      return each.ledBy && lead ? [[each.id, { handle: each.ledBy, name: lead.name }]] : []
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

// A lead and the terminals it leads, by id, its workers in the roster's order.
export type Team = { readonly lead: string; readonly workers: readonly string[] }

// Whether two teams are the same lead with the same workers, as the roster gives a new
// list of them each time any terminal changes.
export const sameTeam = (a: Team | undefined, b: Team | undefined): boolean =>
  a === b ||
  (a !== undefined &&
    b !== undefined &&
    a.lead === b.lead &&
    a.workers.length === b.workers.length &&
    a.workers.every((id, index) => id === b.workers[index]))

// The teams of a roster's running leads: by lead, its workers, and by worker, its lead. A
// team lasts as long as its lead runs, as the leads above do.
const teamsOf = remembered(
  (
    roster,
  ): {
    readonly workers: ReadonlyMap<string, readonly string[]>
    readonly leads: ReadonlyMap<string, string>
  } => {
    const live = liveHandles(roster)
    const workers = new Map<string, string[]>()
    const leads = new Map<string, string>()
    for (const each of roster.terminals) {
      const lead = each.ledBy ? live.get(each.ledBy) : undefined
      if (!lead || lead.id === each.id) continue
      leads.set(each.id, lead.id)
      workers.set(lead.id, [...(workers.get(lead.id) ?? []), each.id])
    }
    return { workers, leads }
  },
)

// The team a terminal belongs to, as the sidebar shows it while the terminal is selected:
// the one it leads, or else the one it works in. A terminal in neither has none.
export const teamOf = (workspace: Workspace, terminalId: string): Team | undefined => {
  const { workers, leads } = teamsOf(rosterOf(workspace))
  const lead = workers.has(terminalId) ? terminalId : leads.get(terminalId)
  return lead === undefined ? undefined : { lead, workers: workers.get(lead)! }
}

// What a terminal is in the selected terminal's team: its lead, one of its workers, or
// nothing, as no team is selected or it isn't in it.
export const teamRole = (
  workspace: Workspace,
  terminalId: string,
): "lead" | "worker" | undefined => {
  const team = teamOf(workspace, activeSession(workspace)!.state.selected)
  if (!team) return undefined
  if (team.lead === terminalId) return "lead"
  return team.workers.includes(terminalId) ? "worker" : undefined
}
