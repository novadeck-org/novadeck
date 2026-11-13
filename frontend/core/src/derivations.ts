import type { MessagePeer } from "./messages"
import { remembered } from "./roster"
import { activeSession } from "./state"
import { handleText } from "./terminals/handle"
import { isAgentProgram } from "./terminals/process"
import type { TerminalMetadata, TerminalRoster, Workspace } from "./types"

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

// The terminals that can lead, by id, a sleeping agent included. One closed, exited or not yet
// started leads no one.
const liveTerminals = remembered((roster): ReadonlyMap<string, TerminalMetadata> => {
  const live = new Map<string, TerminalMetadata>()
  for (const each of roster.terminals)
    if (
      each.handle !== undefined &&
      (each.state === "idle" ||
        each.state === "running" ||
        each.state === "sleeping" ||
        each.state === "finished")
    )
      live.set(each.id, each)
  return live
})

// The leads of a roster's terminals that run, by terminal id: each lead's handle and
// name. A terminal whose lead is closed, exited or not yet started has none.
const leadsOf = remembered((roster): Readonly<Record<string, RunningLead>> => {
  const live = liveTerminals(roster)
  return Object.fromEntries(
    roster.terminals.flatMap((each) => {
      const lead = each.ledBy ? live.get(each.ledBy) : undefined
      return lead?.handle ? [[each.id, { handle: lead.handle, name: lead.name }]] : []
    }),
  )
})

// The leads of the current session's terminals that run, by terminal id.
export const runningLeads = (workspace: Workspace): Readonly<Record<string, RunningLead>> =>
  leadsOf(rosterOf(workspace))

// How a terminal's critter stands, wherever it's drawn (Messages, and with Agent avatars its
// tab and window): hopping while its agent works, at rest while it's idle or asleep, and dim
// once no agent runs there.
export const critterLive = (each: TerminalMetadata): MessagePeer["live"] =>
  each.state === "sleeping"
    ? "idle"
    : each.state !== "running" || !(each.agent || isAgentProgram(each.process))
      ? "gone"
      : each.agent?.working || each.agent?.shellCommand
        ? "working"
        : "idle"

// The current session's terminals as their messages show them, by terminal id, which name the
// agents its messages are with and say whether each is there.
const peersOf = remembered((roster): Readonly<Record<string, MessagePeer>> =>
  Object.fromEntries(
    roster.terminals.flatMap((each): [string, MessagePeer][] =>
      each.handle
        ? [
            [
              each.id,
              {
                name: each.name,
                terminalId: each.id,
                handle: each.handle,
                program: each.state === "running" ? each.process : undefined,
                live: critterLive(each),
              },
            ],
          ]
        : [],
    ),
  ),
)

export const messagePeers = (workspace: Workspace): Readonly<Record<string, MessagePeer>> =>
  peersOf(rosterOf(workspace))

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
    const live = liveTerminals(roster)
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

// The leads above a terminal, nearest first: its lead, its lead's lead, and so on up to a
// terminal no one leads. Agents can lead agents that lead others (nested teams); a loop of
// leads, which nothing forbids, ends where it would come round again.
export const leadChain = (workspace: Workspace, terminalId: string): readonly string[] => {
  const { leads } = teamsOf(rosterOf(workspace))
  const chain: string[] = []
  for (let lead = leads.get(terminalId); lead !== undefined; lead = leads.get(lead)) {
    if (lead === terminalId || chain.includes(lead)) break
    chain.push(lead)
  }
  return chain
}

// Every terminal a lead leads, and those they lead in turn, each once.
export const descendantsOf = (workspace: Workspace, lead: string): readonly string[] => {
  const { workers } = teamsOf(rosterOf(workspace))
  const found: string[] = []
  const walk = (id: string) => {
    for (const worker of workers.get(id) ?? []) {
      if (worker === lead || found.includes(worker)) continue
      found.push(worker)
      walk(worker)
    }
  }
  walk(lead)
  return found
}

// What lights for a selected terminal in the sidebar: every team it leads or works in, whole,
// and above them the way up through each lead to the top, one lead and the member below it
// at a time (`path`), its other members left at rest.
export type LitTeams = {
  readonly full: readonly Team[]
  readonly path: readonly { readonly lead: string; readonly child: string }[]
}

export const litTeams = (workspace: Workspace, selected: string): LitTeams => {
  const { workers, leads } = teamsOf(rosterOf(workspace))
  const full: Team[] = []
  if (workers.has(selected)) full.push({ lead: selected, workers: workers.get(selected)! })
  const own = leads.get(selected)
  if (own !== undefined) full.push({ lead: own, workers: workers.get(own)! })
  const chain = leadChain(workspace, selected)
  const path = chain.slice(1).map((lead, index) => ({ lead, child: chain[index]! }))
  return { full, path }
}

// What a terminal is in the tree of teams the selected terminal is in (its tabs take the team's
// tint, nested teams whole): a lead (it leads anyone in it) or a worker, from the top lead
// down, whichever member is selected; nothing for a terminal outside it, or while the
// selected terminal is in no team.
export const treeRole = (
  workspace: Workspace,
  terminalId: string,
): "lead" | "worker" | undefined => {
  const selected = activeSession(workspace)!.state.selected
  const { workers, leads } = teamsOf(rosterOf(workspace))
  if (!workers.has(selected) && !leads.has(selected)) return undefined
  const root = leadChain(workspace, selected).at(-1) ?? selected
  if (terminalId !== root && !descendantsOf(workspace, root).includes(terminalId)) return undefined
  return workers.has(terminalId) ? "lead" : "worker"
}

// Whether two lit sets are the same.
export const sameLitTeams = (a: LitTeams, b: LitTeams): boolean =>
  a === b ||
  (sameTeams(a.full, b.full) &&
    a.path.length === b.path.length &&
    a.path.every(
      (step, index) => step.lead === b.path[index]!.lead && step.child === b.path[index]!.child,
    ))

// Every team of the current session's running leads, as Grid and Canvas draw them whatever
// is selected: in the order each lead's first worker appears in the roster, which Grid
// routes them in, the earlier ones taking the clearer gutters.
export const allTeams = (workspace: Workspace): readonly Team[] => {
  const { workers } = teamsOf(rosterOf(workspace))
  return [...workers].map(([lead, led]) => ({ lead, workers: led }))
}

// Whether two lists of teams are the same teams in the same order.
export const sameTeams = (a: readonly Team[], b: readonly Team[]): boolean =>
  a === b || (a.length === b.length && a.every((team, index) => sameTeam(team, b[index])))

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

// Words as a sentence lists them, and past `shown`, how many more (counted from two, as
// naming one more is as short): "@a, @b and @c", "@a, @b, @c and 4 more".
const listed = (words: readonly string[], shown = 3): string => {
  const named =
    words.length > shown + 1 ? [...words.slice(0, shown), `${words.length - shown} more`] : words
  return named.length < 2
    ? (named[0] ?? "")
    : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`
}

// A terminal of the roster as its team names it: by handle, by name where it has none.
const memberName = (roster: TerminalRoster, id: string): string => {
  const each = roster.terminals.find((terminal) => terminal.id === id)
  return each?.handle ? handleText(each.handle) : (each?.name ?? id)
}

// Whom a lead directs, in words: up to four named, or three and the rest counted.
const ledWords = (roster: TerminalRoster, led: readonly string[]): string =>
  listed([...led.slice(0, 4).map((id) => memberName(roster, id)), ...led.slice(4)])

// A terminal's team in words, for its tab's description, as the rail's wire only draws it:
// who leads it and whom it leads, by handle (by name where one has none). Nothing for a
// terminal in no team. Unlike the wire, it holds whatever is selected.
export const teamText = (workspace: Workspace, terminalId: string): string | undefined => {
  const roster = rosterOf(workspace)
  const { workers, leads } = teamsOf(roster)
  const lead = leads.get(terminalId)
  const led = workers.get(terminalId) ?? []
  const parts = [
    ...(lead === undefined ? [] : [`led by ${memberName(roster, lead)}`]),
    ...(led.length ? [`leads ${ledWords(roster, led)}`] : []),
  ]
  return parts.length ? parts.join(", ") : undefined
}

// The terminals a running lead directs, for its window's header: how many, and who in
// words ("@owl, @crow and @wren"). Nothing for a terminal that leads no one.
export const ledTerminals = (
  workspace: Workspace,
  terminalId: string,
): { readonly count: number; readonly names: string } | undefined => {
  const roster = rosterOf(workspace)
  const led = teamsOf(roster).workers.get(terminalId)
  return led?.length ? { count: led.length, names: ledWords(roster, led) } : undefined
}
