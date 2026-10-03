import type { Project, TerminalSummary, WorkspaceSession } from "@novadeck/protocol"

import { isShellProcess } from "../../model/process"
import type { SessionSeed, WorkspaceSeed } from "../../model/seed"
import type { TerminalMetadata } from "../../model/types"
import { defaultQuickExitMs, restartable, terminalActivity } from "./activity"
import { decodeSession } from "./session-state"

// Everything the runner reported at startup, one entry per project.
export type RunnerListing = readonly {
  readonly project: Project
  readonly sessions: readonly {
    readonly session: WorkspaceSession
    readonly terminals: readonly TerminalSummary[]
  }[]
}[]

// A terminal the UI has just asked for, before the runner reports on it: named as asked,
// or with a placeholder until the runner gives it its session's next default title.
export const startingTerminal = (
  id: string,
  directory: string,
  title?: string,
): TerminalMetadata => ({
  id,
  name: title ?? newTerminalName,
  directory,
  command: "",
  process: "",
  state: "starting",
})

// What a new terminal shows until the runner names it.
export const newTerminalName = "New terminal"

// The program a fresh shell resumes in a terminal whose shell was lost or ended.
const restored = (summary: TerminalSummary): Pick<TerminalMetadata, "restoredProcess"> =>
  summary.lastProgram && !isShellProcess(summary.lastProgram)
    ? { restoredProcess: summary.lastProgram }
    : {}

// A terminal as the runner keeps it, or undefined once its shell exited cleanly, which
// closes it. One the runner has no shell for, as after it restarted, needs a fresh one.
// A shell that exited sooner than `quickExitMs` after starting failed to start.
export const runnerTerminal = (
  summary: TerminalSummary,
  quickExitMs = defaultQuickExitMs,
): TerminalMetadata | undefined => {
  const identity = {
    id: summary.id,
    name: summary.title,
    directory: summary.cwd,
    command: summary.command ?? "",
    handle: summary.handle,
    titleSource: summary.titleSource,
  }
  if (!summary.started) return { ...identity, ...restored(summary), process: "", state: "starting" }
  const { status, process } = terminalActivity(summary, quickExitMs)
  if (status === "clean") return undefined
  return {
    ...identity,
    ...(restartable(status) ? restored(summary) : {}),
    process: process ?? "",
    ...status,
  }
}

// A session's seed and where it sorts: by last visit, then by how open it was.
type Ranked = { readonly seed: SessionSeed; readonly order: readonly [number, number] }

// The session's terminals are the runner's, in the order they were created; how the UI
// showed them, as it saved that, lays them out again.
const sessionSeed = (
  session: WorkspaceSession,
  summaries: readonly TerminalSummary[],
  quickExitMs: number,
): Ranked => {
  const saved = decodeSession(session.state)
  const terminals = summaries.flatMap((summary) => {
    const terminal = runnerTerminal(summary, quickExitMs)
    return terminal ? [terminal] : []
  })
  // Visit times are epoch milliseconds, so -1 sorts a session never saved last.
  if (!saved) return { seed: { id: session.id, name: session.name, terminals }, order: [-1, 0] }
  const seed: SessionSeed = {
    id: session.id,
    name: session.name,
    terminals,
    visitedAt: saved.visitedAt,
    restored: saved.state,
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

// Terminals the runner keeps without a shell, as after it restarted: they need a fresh one.
export const lostTerminals = (listing: RunnerListing): ReadonlySet<string> =>
  new Set(
    listing.flatMap(({ sessions }) =>
      sessions.flatMap(({ terminals }) =>
        terminals.flatMap((terminal) => (terminal.started ? [] : [terminal.id])),
      ),
    ),
  )

export const runnerSeed = (
  listing: RunnerListing,
  quickExitMs = defaultQuickExitMs,
): WorkspaceSeed => {
  const ranked = listing.map(({ project, sessions }) => ({
    project,
    sessions: sessions
      .map(({ session, terminals }) => sessionSeed(session, terminals, quickExitMs))
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
