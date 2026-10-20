import type { Team } from "@novadeck/core/derivations"
import { useEffect, useMemo, useState } from "react"

import { blinkMs } from "../../terminals/team-wire"
import { teamRoute, type Point, type Run, type TileBox } from "./team-route"

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

// The selected terminal's team through the Grid's gutters: a block cursor left of the
// lead's tile, a tick into each worker's, and runs between them that never cross a tile.
// Selecting a member sends one pulse from the lead along the runs, lighting each tick as it
// arrives. It sits in the grid's own frame, so it scrolls with the tiles, takes no pointer
// and is only drawn, as the window's header says who leads a terminal in words.
export const GridTeamWire = ({
  team,
  selected,
  boxes,
  gap,
  width,
  hidden,
}: {
  team: Team | undefined
  // The selected terminal: selecting another member plays the pulse again.
  selected: string
  // The tiles as laid out now.
  boxes: readonly TileBox[]
  gap: number
  width: number
  // While a window is dropped on the grid; a tile dragged or resized is the stylesheet's.
  hidden: boolean
}): React.JSX.Element | null => {
  // The route is worked out again only when the tiles or the team moved, not on every
  // update of the roster that hands over the same boxes anew.
  const geometry = `${width}|${boxes.map((box) => `${box.id}:${box.left},${box.top},${box.width},${box.height}`).join("|")}`
  const members = team ? [team.lead, ...team.workers].join("|") : ""
  const route = useMemo(
    () => (team ? teamRoute(boxes, team.lead, team.workers, gap, width) : undefined),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [geometry, members, gap],
  )
  // The tiles slide to a new layout over a moment: the wire is out of the way until they
  // have, then fades back without playing its pulse again.
  const [still, setStill] = useState(geometry)
  useEffect(() => {
    const timer = setTimeout(() => setStill(geometry), movingMs)
    return () => clearTimeout(timer)
  }, [geometry])
  // The selection whose pulse has played.
  const [played, setPlayed] = useState<string | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setPlayed(selected), blinkMs + longest + 200)
    return () => clearTimeout(timer)
  }, [selected])
  if (!route) return null
  return (
    <div
      className="grid-team-wire"
      aria-hidden
      data-hidden={hidden || still !== geometry || undefined}
      data-settled={played === selected || undefined}
      style={{ "--team-wire-blink": `${blinkMs}ms` } as React.CSSProperties}
    >
      <div key={selected} className="grid-team-wire-shape">
        {route.runs.map((run) => (
          <i
            key={`${run.axis}${run.x},${run.y}`}
            className="grid-team-wire-run"
            data-axis={run.axis}
            style={place(run)}
          />
        ))}
        <i
          className="grid-team-wire-cursor"
          style={{ left: route.cursor[0], top: route.cursor[1] }}
        />
        {route.workers.map((worker) => (
          <i
            key={worker.id}
            className="grid-team-wire-tick"
            style={
              {
                ...place(worker.tick),
                "--_at": `${Math.round(blinkMs + duration(worker.distance))}ms`,
              } as React.CSSProperties
            }
          />
        ))}
        {route.workers.map((worker) => (
          <i
            key={worker.id}
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
    </div>
  )
}
