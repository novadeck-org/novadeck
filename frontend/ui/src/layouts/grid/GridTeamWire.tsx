import type { Team } from "@novadeck/core/derivations"
import { useEffect, useMemo, useState } from "react"

import { blinkMs } from "../../terminals/team-wire"
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
// dim, as the rail's do; the selected terminal's team lights, and plays its entrance each
// time one of its members is selected: its runs draw in, its ticks reach out after them and
// its cursor blinks twice. It sits in the grid's own frame, so it scrolls with the tiles,
// takes no pointer and is only drawn, as the window's header says who leads a terminal in
// words.
export const GridTeamWire = ({
  teams,
  team,
  selected,
  boxes,
  gap,
  width,
  hidden,
}: {
  teams: readonly Team[]
  // The selected terminal's team: its wire lights, the others rest.
  team: Team | undefined
  selected: string
  // The tiles as laid out now.
  boxes: readonly TileBox[]
  gap: number
  width: number
  // While a window is dropped on the grid; a tile dragged or resized is the stylesheet's.
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
  // The selection whose entrance has played, counted only once it played in view: the wire
  // comes back from a layout change as it was, without playing it again. Any change of
  // selection forgets it, so coming back to a member before the timer fires plays it again.
  const [played, setPlayed] = useState<string | undefined>(undefined)
  const [seen, setSeen] = useState(selected)
  if (seen !== selected) {
    setSeen(selected)
    setPlayed(undefined)
  }
  useEffect(() => {
    if (out) return
    const timer = setTimeout(() => setPlayed(selected), blinkMs + 200)
    return () => clearTimeout(timer)
  }, [selected, out])
  const settled = played === selected
  const wires = routes.flatMap((route, i) => (route ? [{ route, lead: teams[i]!.lead }] : []))
  if (!wires.length) return null
  // The lit wire is drawn last, over any resting one it crosses.
  const lit = wires.find(({ lead }) => lead === team?.lead)
  return (
    <div
      className="grid-team-wire"
      aria-hidden
      data-hidden={out || undefined}
      data-settled={settled || undefined}
    >
      {wires.map((wire) => wire !== lit && <Wire key={wire.lead} route={wire.route} lit={false} />)}
      {/* Drawn anew for each selection, and while its entrance hasn't played, as the wires
          come into view, so it plays where it can be seen. */}
      {lit && (
        <Wire
          key={`${lit.lead}:${selected}${settled || out ? "" : ":shown"}`}
          route={lit.route}
          lit
        />
      )}
    </div>
  )
}

const Wire = ({ route, lit }: { route: TeamRoute; lit: boolean }): React.JSX.Element => (
  <div className="grid-team-wire-shape" data-lit={lit || undefined}>
    {route.runs.map((run) => (
      <i
        key={`${run.axis}${run.x},${run.y}`}
        className="grid-team-wire-run"
        data-axis={run.axis}
        style={place(run)}
      />
    ))}
    {route.workers.map((worker) => (
      <i key={worker.id} className="grid-team-wire-tick" style={place(worker.tick)} />
    ))}
    <i className="grid-team-wire-cursor" style={{ left: route.cursor[0], top: route.cursor[1] }} />
  </div>
)
