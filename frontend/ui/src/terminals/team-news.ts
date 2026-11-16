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

// How soon after one view starts a piece's entrance another view drawing the same piece plays
// it too, as the rail and Grid do side by side; later, it is old news.
const togetherMs = 150

export type TeamNews = {
  // Notes that a view draws the current session's teams as they are at `now`, and says which
  // pieces enter there: those new since the session's teams were last drawn anywhere, and
  // those another view began to play a moment ago.
  readonly draw: (teams: readonly Team[], now: number) => ReadonlySet<string>
}

// One per App: `session` names the session the views show now.
export const createTeamNews = (session: () => string): TeamNews => {
  const drawn = new Map<string, Crews>()
  const started = new Map<string, ReadonlyMap<string, number>>()
  return {
    draw: (teams, now) => {
      const key = session()
      const recent = [...(started.get(key) ?? [])].filter(([, at]) => now - at < togetherMs)
      const fresh = newPieces(drawn.get(key), teams).map((piece) => [piece, now] as const)
      drawn.set(key, crewsOf(teams))
      const entering = new Map([...recent, ...fresh])
      started.set(key, entering)
      return new Set(entering.keys())
    },
  }
}

export const TeamNewsContext = createContext<TeamNews | null>(null)

// How long a piece stays marked as entering: past the longest entrance (team-wire.css,
// grid-team-wire.css, canvas.css), with room for its first frame to come late.
const enteringMs = 1000

const none: ReadonlySet<string> = new Set()

// The pieces of `teams` entering in a view, while it `shows` them: each for as long as its
// entrance plays. Without the App's TeamNews nothing enters.
export const useEnteringPieces = (teams: readonly Team[], shows: boolean): ReadonlySet<string> => {
  const news = useContext(TeamNewsContext)
  // What enters in this view, kept beside it: the layout effect below notes what it drew there
  // and the view draws what enters before that frame paints.
  const [view] = useState(() => createStore(none))
  const entering = useSyncExternalStore(view.subscribe, view.getSnapshot)
  // Ends the entrances: kept as they play, however often the teams are handed over anew.
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useLayoutEffect(() => {
    if (!news || !shows) return
    const pieces = news.draw(teams, performance.now())
    if (!pieces.size) return
    view.update((current) => new Set([...current, ...pieces]))
    clearTimeout(timer.current)
    timer.current = setTimeout(() => view.update(() => none), enteringMs)
  }, [news, teams, shows, view])
  useEffect(() => () => clearTimeout(timer.current), [])
  return entering
}
