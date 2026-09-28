import type { Project, TerminalSummary, WorkspaceSession } from "@novadeck/protocol"

import type { SessionSeed, WorkspaceSeed } from "../../model/seed"
import type { TerminalMetadata } from "../../model/types"
import { restartable, terminalActivity } from "./activity"
import { decodeSession, type SavedTerminal } from "./session-state"

// Everything the runner reported at startup, one entry per project.
export type RunnerListing = readonly {
  readonly project: Project
  readonly sessions: readonly {
    readonly session: WorkspaceSession
    readonly terminals: readonly TerminalSummary[]
  }[]
}[]

export const terminalName = (number: number): string =>
  `Terminal ${String(number).padStart(2, "0")}`

// A terminal the UI has just asked for, before the runner reports on it.
export const startingTerminal = (
  id: string,
  number: number,
  directory: string,
): TerminalMetadata => ({
  id,
  name: terminalName(number),
  directory,
  command: "",
  process: "",
  state: "starting",
})

// What a saved terminal keeps as itself; its `lastProcess` only feeds `restoredProcess`.
const identity = ({ id, name, directory }: SavedTerminal) => ({ id, name, directory })

// The program to resume in a terminal whose shell was lost or ended; a live shell has
// nothing to restore.
const restored = (saved: SavedTerminal): Pick<TerminalMetadata, "restoredProcess"> =>
  saved.lastProcess ? { restoredProcess: saved.lastProcess } : {}

// A terminal as the runner reports it, or undefined once its shell exited cleanly,
// which closes it.
const liveTerminal = (
  saved: SavedTerminal,
  summary: TerminalSummary,
): TerminalMetadata | undefined => {
  const { status, process } = terminalActivity(summary)
  if (status === "clean") return undefined
  return {
    ...identity(saved),
    ...(restartable(status) ? restored(saved) : {}),
    command: "",
    process: process ?? "",
    ...status,
  }
}

// A saved terminal whose process the runner no longer has, as after a restart or a
// relaunch. The adapter starts a fresh shell for it in place.
const lostTerminal = (saved: SavedTerminal): TerminalMetadata => ({
  ...identity(saved),
  ...restored(saved),
  command: "",
  process: "",
  state: "starting",
})

// A session's seed and where it sorts: by last visit, then by how open it was.
type Ranked = { readonly seed: SessionSeed; readonly order: readonly [number, number] }

// Saved terminals keep their names and places; the runner's other running terminals
// in the session follow with default names, numbered on from the saved counter.
// Exited terminals the save does not know were closed here or elsewhere; they stay out.
const sessionSeed = (session: WorkspaceSession, summaries: readonly TerminalSummary[]): Ranked => {
  const saved = decodeSession(session.state)
  const live = new Map(summaries.map((summary) => [summary.id, summary]))
  const known = saved?.state.roster.terminals ?? []
  const kept = known.flatMap((terminal) => {
    const summary = live.get(terminal.id)
    if (!summary) return [lostTerminal(terminal)]
    const current = liveTerminal(terminal, summary)
    return current ? [current] : []
  })
  const first = saved?.state.roster.nextNumber ?? 1
  const extra = summaries
    .filter(
      (summary) => summary.exit === null && !known.some((terminal) => terminal.id === summary.id),
    )
    .flatMap((summary, index) => {
      const current = liveTerminal(
        {
          id: summary.id,
          name: terminalName(first + index),
          directory: summary.cwd,
          lastProcess: "",
        },
        summary,
      )
      return current ? [current] : []
    })
  const terminals = [...kept, ...extra]
  // Visit times are epoch milliseconds, so -1 sorts a session never saved last.
  if (!saved) return { seed: { id: session.id, name: session.name, terminals }, order: [-1, 0] }
  // A selected terminal that closed while the app was away hands selection on.
  const remaining = new Set(kept.map((terminal) => terminal.id))
  const selected = remaining.has(saved.state.selected)
    ? saved.state.selected
    : ([...saved.state.roster.order, ...kept.map((terminal) => terminal.id)].find((id) =>
        remaining.has(id),
      ) ?? "")
  const seed: SessionSeed = {
    id: session.id,
    name: session.name,
    terminals,
    visitedAt: saved.visitedAt,
    restored: {
      ...saved.state,
      selected,
      roster: {
        ...saved.state.roster,
        order: [...saved.state.roster.order],
        terminals: kept,
      },
    },
  }
  return { seed, order: [saved.visitedAt, saved.rank] }
}

const later = (a: Ranked | undefined, b: Ranked | undefined): number => {
  const [visitA, rankA] = a?.order ?? [-2, 0]
  const [visitB, rankB] = b?.order ?? [-2, 0]
  return visitA - visitB || rankA - rankB
}

// The workspace as the runner left it: sessions most recently visited first, and the
// project visited last opens. Sessions visited at the same moment, as a switch leaves
// them, sort the one that was open first. Sessions never saved follow in the runner's order.
// Terminals whose shells exited cleanly while the app was away: the seed leaves them
// out, and the adapter closes what the runner still keeps of them.
export const cleanlyExited = (listing: RunnerListing): readonly string[] =>
  listing.flatMap(({ sessions }) =>
    sessions.flatMap(({ terminals }) =>
      terminals.flatMap((terminal) =>
        terminalActivity(terminal).status === "clean" ? [terminal.id] : [],
      ),
    ),
  )

// The run each terminal is on, so a later report about an earlier run is ignored.
export const terminalRuns = (listing: RunnerListing): ReadonlyMap<string, number> =>
  new Map(
    listing.flatMap(({ sessions }) =>
      sessions.flatMap(({ terminals }) => terminals.map((terminal) => [terminal.id, terminal.run])),
    ),
  )

// Saved terminals the runner does not have: they need a fresh shell.
export const lostTerminals = (listing: RunnerListing): ReadonlySet<string> =>
  new Set(
    listing.flatMap(({ sessions }) =>
      sessions.flatMap(({ session, terminals }) => {
        const live = new Set(terminals.map((terminal) => terminal.id))
        const known = decodeSession(session.state)?.state.roster.terminals ?? []
        return known.flatMap((terminal) => (live.has(terminal.id) ? [] : [terminal.id]))
      }),
    ),
  )

export const runnerSeed = (listing: RunnerListing): WorkspaceSeed => {
  const ranked = listing.map(({ project, sessions }) => ({
    project,
    sessions: sessions
      .map(({ session, terminals }) => sessionSeed(session, terminals))
      .toSorted((a, b) => later(b, a)),
  }))
  const latest = ranked.reduce<(typeof ranked)[number] | undefined>(
    (best, item) =>
      best?.sessions[0] && later(item.sessions[0], best.sessions[0]) <= 0 ? best : item,
    undefined,
  )
  const projects = ranked.map(({ project, sessions }) => ({
    id: project.id,
    name: project.name,
    directory: project.cwd,
    sessions: sessions.map((session) => session.seed),
  }))
  return latest?.sessions[0] && latest.sessions[0].order[0] >= 0
    ? { projects, activeProjectId: latest.project.id }
    : { projects }
}
