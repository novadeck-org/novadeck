import type { Team } from "@novadeck/core/derivations"
import { useEffect, useMemo, useState } from "react"

import { memberPiece, teamPiece, useEnteringPieces } from "../../terminals/team-news"
import { teamRoutes, type Run, type TeamRoute, type TileBox } from "./team-route"

import "./grid-team-wire.css"

// How long the tiles take to settle after the layout changes.
const movingMs = 400

const place = (run: Run): React.CSSProperties =>
  run.axis === "horizontal"
    ? { left: run.x, top: run.y, width: run.length + 1 }
    : { left: run.x, top: run.y, height: run.length + 1 }

// Every team's wire through the Grid's gutters: a block cursor left of the lead's tile, a
// tick into each worker's, and runs between them that never cross a tile. Every wire rests,
// dim, as the rail's do; the selected terminal's team lights. Only a change to a team plays
// (team-news.ts): a team forming draws in, its runs first, its ticks reaching out after them
// and its cursor blinking twice, and a teammate joining reaches out its tick. It sits in the
// grid's own frame, so it scrolls with the tiles,
// takes no pointer and is only drawn, as the window's header says who leads a terminal in
// words.
export const GridTeamWire = ({
  teams,
  team,
  boxes,
  gap,
  width,
  hidden,
}: {
  teams: readonly Team[]
  // The selected terminal's team: its wire lights, the others rest.
  team: Team | undefined
  // The tiles as laid out now.
  boxes: readonly TileBox[]
  gap: number
  width: number
  // While a window is dropped on the grid; a tile dragged is the stylesheet's.
  hidden: boolean
}): React.JSX.Element | null => {
  const geometry = `${width}|${boxes.map((box) => `${box.id}:${box.left},${box.top},${box.width},${box.height}`).join("|")}`
  const crews = teams.map((each) => [each.lead, ...each.workers].join("|")).join("\n")
  // The tiles slide to a new layout over a moment: the wires are out of the way until they
  // have, then fade back without playing anything again.
  const [still, setStill] = useState(geometry)
  useEffect(() => {
    const timer = setTimeout(() => setStill(geometry), movingMs)
    return () => clearTimeout(timer)
  }, [geometry])
  // The routes are worked out again each time the tiles come to rest, by the timer or by
  // landing back where they were, and when a team changes: not on every frame of a resize,
  // while they are hidden anyway (only once, as the tiles start to move), nor on every
  // update of the roster that hands over the same boxes anew.
  const resting = still === geometry ? geometry : "moving"
  const routes = useMemo(
    () => teamRoutes(boxes, teams, gap, width),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [resting, crews, gap],
  )
  const out = hidden || still !== geometry
  // What plays, once the tiles are at rest and the wires show: a layout change brings them
  // back as they were, without playing anything again.
  const entering = useEnteringPieces(teams, !out)
  const wires = routes.flatMap((route, i) => (route ? [{ route, lead: teams[i]!.lead }] : []))
  if (!wires.length) return null
  // Each wire keeps its element whether it lights or rests, so lighting fades; the stylesheet
  // raises the lit one over any resting one it crosses.
  return (
    <div className="grid-team-wire" aria-hidden data-hidden={out || undefined}>
      {wires.map((wire) => (
        <Wire
          key={wire.lead}
          route={wire.route}
          lit={wire.lead === team?.lead}
          entering={entering.has(teamPiece(wire.lead))}
          joining={(id) => entering.has(memberPiece(wire.lead, id))}
        />
      ))}
    </div>
  )
}

const Wire = ({
  route,
  lit,
  entering,
  joining,
}: {
  route: TeamRoute
  lit: boolean
  // Its team just formed, and draws in whole; a teammate who just joined it reaches out alone.
  entering: boolean
  joining: (id: string) => boolean
}): React.JSX.Element => (
  <div
    className="grid-team-wire-shape"
    data-lit={lit || undefined}
    data-entering={entering || undefined}
  >
    {route.runs.map((run) => (
      <i
        key={`${run.axis}${run.x},${run.y}`}
        className="grid-team-wire-run"
        data-axis={run.axis}
        style={place(run)}
      />
    ))}
    {route.workers.map((worker) => (
      <i
        key={worker.id}
        className="grid-team-wire-tick"
        data-joining={joining(worker.id) || undefined}
        style={place(worker.tick)}
      />
    ))}
    <i className="grid-team-wire-cursor" style={{ left: route.cursor[0], top: route.cursor[1] }} />
  </div>
)
