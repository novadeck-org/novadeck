import type { Team } from "@novadeck/core/derivations"
import { useEffect, useMemo, useState } from "react"

import { blinkMs } from "../../terminals/team-wire"
import { teamRoutes, type Point, type Run, type TeamRoute, type TileBox } from "./team-route"

import "./grid-team-wire.css"

// How fast the pulse runs along the wire, in pixels a millisecond, and the longest it takes.
const speed = 1.2
const longest = 900
// How long the tiles take to settle after the layout changes.
const movingMs = 400

const duration = (distance: number) => Math.min(longest, distance / speed)

const place = (run: Run): React.CSSProperties =>
  run.axis === "horizontal"
    ? { left: run.x, top: run.y, width: run.length + 1 }
    : { left: run.x, top: run.y, height: run.length + 1 }

const pathOf = (points: readonly Point[]) =>
  points.map(([x, y], i) => `${i ? "L" : "M"}${x} ${y}`).join(" ")

// Every team's wire through the Grid's gutters: a block cursor left of the lead's tile, a
// tick into each worker's, and runs between them that never cross a tile. A wire draws in
// when it first appears and stays; selecting a member of a team blinks its cursor and sends
// one pulse from the lead along its runs to each tick, which stay as they are. It sits in the
// grid's own frame, so it scrolls with the tiles, takes no pointer and is only drawn, as the
// window's header says who leads a terminal in words.
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
  // The selected terminal's team: its wire plays the pulse, the others stay as they are.
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
  // while they are hidden anyway, nor on every update of the roster that hands over the
  // same boxes anew.
  const resting = still === geometry ? geometry : "moving"
  const routes = useMemo(
    () => teamRoutes(boxes, teams, gap, width),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [resting, crews, gap],
  )
  const wires = routes.flatMap((route, i) => (route ? [{ route, lead: teams[i]!.lead }] : []))
  if (!wires.length) return null
  const out = hidden || still !== geometry
  return (
    <div
      className="grid-team-wire"
      aria-hidden
      data-hidden={out || undefined}
      style={{ "--team-wire-blink": `${blinkMs}ms` } as React.CSSProperties}
    >
      {wires.map(({ route, lead }) => (
        <Wire
          key={lead}
          route={route}
          visible={!out}
          selected={team?.lead === lead ? selected : undefined}
        />
      ))}
    </div>
  )
}

// One team's wire. `selected` is the selected member of this team, while there is one. A
// wire starts to draw in when it is first seen, not when it is made: a new team comes with
// a new tile, and the wires wait out the tiles' slide.
const Wire = ({
  route,
  visible,
  selected,
}: {
  route: TeamRoute
  visible: boolean
  selected: string | undefined
}): React.JSX.Element => {
  // Whether the wire has drawn in, and the selection whose pulse has played.
  const [appeared, setAppeared] = useState(visible)
  if (visible && !appeared) setAppeared(true)
  const [drawn, setDrawn] = useState(false)
  const [played, setPlayed] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (!appeared) return
    const timer = setTimeout(() => setDrawn(true), movingMs)
    return () => clearTimeout(timer)
  }, [appeared])
  // Leaving the team forgets the pulse, so coming back to it plays it again.
  const [seen, setSeen] = useState(selected)
  if (seen !== selected) {
    setSeen(selected)
    if (!selected) setPlayed(undefined)
  }
  useEffect(() => {
    if (!selected || !appeared) return
    const timer = setTimeout(() => setPlayed(selected), blinkMs + longest + 200)
    return () => clearTimeout(timer)
  }, [selected, appeared])
  const pulsing = selected !== undefined && played !== selected
  if (!appeared) return <div className="grid-team-wire-shape" />
  return (
    <div
      className="grid-team-wire-shape"
      data-drawn={drawn || undefined}
      data-pulsing={pulsing || undefined}
    >
      {route.runs.map((run) => (
        <i
          key={`${run.axis}${run.x},${run.y}`}
          className="grid-team-wire-run"
          data-axis={run.axis}
          style={place(run)}
        />
      ))}
      <i
        key={selected ?? ""}
        className="grid-team-wire-cursor"
        style={{ left: route.cursor[0], top: route.cursor[1] }}
      />
      {route.workers.map((worker) => (
        <i key={worker.id} className="grid-team-wire-tick" style={place(worker.tick)} />
      ))}
      {pulsing &&
        route.workers.map((worker) => (
          <i
            key={`${worker.id}:${selected}`}
            className="grid-team-wire-pulse"
            style={
              {
                offsetPath: `path("${pathOf(worker.path)}")`,
                "--_duration": `${Math.round(duration(worker.distance))}ms`,
              } as React.CSSProperties
            }
          />
        ))}
    </div>
  )
}
