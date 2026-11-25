import type { Team } from "@novadeck/core/derivations"
import { createStore } from "@novadeck/core/store"
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react"

// What of a session's teams is new to the person, so a team wire (the rail's, Grid's and
// Canvas's) plays an entrance only as the team itself changes: a team that gets its first
// teammate draws in whole, and a teammate who joins one already drawn reaches out alone. How it
// is looked at never plays one: selecting a member, scrolling, switching sessions or views, the
// sidebar coming back, or a wire drawn anew. What a session holds when the person first looks at
// it is where it starts, and a change made while they were elsewhere plays once they look.

// The pieces that enter: a team, whole, and a teammate's tick in it.
export const teamPiece = (lead: string): string => `team ${lead}`
export const memberPiece = (lead: string, worker: string): string => `member ${lead} ${worker}`

// Who was in each team as last drawn: by lead, its workers.
type Crews = ReadonlyMap<string, ReadonlySet<string>>

const crewsOf = (teams: readonly Team[]): Crews =>
  new Map(teams.map(({ lead, workers }) => [lead, new Set(workers)]))

// What is new in `teams` since `before` was drawn: a team none of which was drawn, whole (its
// workers come with it), and a worker who joined a team that was. Nothing before anything was
// drawn.
export const newPieces = (before: Crews | undefined, teams: readonly Team[]): readonly string[] =>
  before === undefined
    ? []
    : teams.flatMap(({ lead, workers }) => {
        const crew = before.get(lead)
        return crew
          ? workers.filter((worker) => !crew.has(worker)).map((worker) => memberPiece(lead, worker))
          : [teamPiece(lead)]
      })

// How soon after one view starts a piece's entrance another view drawing the same piece for the
// first time plays it too, as the rail and Grid do side by side.
const togetherMs = 150

// How long news is kept for a view that was showing before it came but couldn't draw it at once,
// as Grid while its tiles settle around a new teammate's tile; later, it is old news.
const keptMs = 5000

// Whose teams a view draws: the terminals' (the rail's, Grid's and Canvas's wires, which share
// their news), or another list's, as a sidebar panel's own leads and members, kept apart so
// neither list's teams read as new to the other's.
export type TeamKind = string
const terminalTeams: TeamKind = "terminals"

export type TeamNews = {
  // Notes that a view draws the current session's teams of a kind as they are at `now`, and
  // says which pieces enter there: those new since that kind's teams were last drawn anywhere,
  // those another view began to play a moment ago, and those that came since this view last
  // drew (`since`, none for a view drawing for the first time).
  readonly draw: (
    teams: readonly Team[],
    now: number,
    since?: number,
    kind?: TeamKind,
  ) => ReadonlySet<string>
}

// One per App: `session` names the session the views show now.
export const createTeamNews = (session: () => string): TeamNews => {
  const drawn = new Map<string, Crews>()
  const came = new Map<string, ReadonlyMap<string, number>>()
  return {
    draw: (teams, now, since, kind = terminalTeams) => {
      const key = kind === terminalTeams ? session() : `${kind} ${session()}`
      const pieces = new Set(
        teams.flatMap(({ lead, workers }) => [
          teamPiece(lead),
          ...workers.map((worker) => memberPiece(lead, worker)),
        ]),
      )
      const kept = [...(came.get(key) ?? [])].filter(
        ([piece, at]) => now - at < keptMs && pieces.has(piece),
      )
      const fresh = newPieces(drawn.get(key), teams).map((piece) => [piece, now] as const)
      drawn.set(key, crewsOf(teams))
      const news = new Map([...kept, ...fresh])
      came.set(key, news)
      return new Set(
        [...news]
          .filter(([, at]) => now - at < togetherMs || (since !== undefined && at > since))
          .map(([piece]) => piece),
      )
    },
  }
}

export const TeamNewsContext = createContext<TeamNews | null>(null)

// How long a piece stays marked as entering: past the longest entrance (team-wire.css,
// grid-team-wire.css, canvas.css), with room for its first frame to come late.
const enteringMs = 1000

const none: ReadonlySet<string> = new Set()

// The pieces of `teams` (of `kind`, the terminals' unless said) entering in a view, while it
// `shows` them: each for as long as its entrance plays. Without the App's TeamNews nothing
// enters.
export const useEnteringPieces = (
  teams: readonly Team[],
  shows: boolean,
  kind: TeamKind = terminalTeams,
): ReadonlySet<string> => {
  const news = useContext(TeamNewsContext)
  // What enters in this view, kept beside it: the layout effect below notes what it drew there
  // and the view draws what enters before that frame paints.
  const [view] = useState(() => createStore(none))
  const entering = useSyncExternalStore(view.subscribe, view.getSnapshot)
  // Ends the entrances: kept as they play, however often the teams are handed over anew.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // When this view last drew: news that came since, while it couldn't, plays as it draws again.
  const drew = useRef<number | undefined>(undefined)
  useLayoutEffect(() => {
    if (!news || !shows) return
    const now = performance.now()
    const pieces = news.draw(teams, now, drew.current, kind)
    drew.current = now
    if (!pieces.size) return
    view.update((current) => new Set([...current, ...pieces]))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => view.update(() => none), enteringMs)
  }, [news, teams, shows, view, kind])
  useEffect(() => () => clearTimeout(timer.current), [])
  return entering
}
