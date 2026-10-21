import type { Team } from "@novadeck/core/derivations"
import { useStore, ViewportPortal, type ReactFlowState } from "@xyflow/react"
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"

import { blinkMs } from "../../terminals/team-wire"
import { chromeScaleAt, terminalHeaderHeight } from "./geometry"
import { teamRoute, type Member, type Point, type Run } from "./team-route"
import type { TerminalNode } from "./types"

// A drawn pulse's streak is this long on the screen, in pixels.
const streakLength = 28

// Every team's wire on the canvas, whatever is selected: while a lead's window and a
// worker's are on it, a block cursor outside the lead's edge at its header line, a line out
// to a trunk that runs past every worker, and a tick into each worker's edge at its header
// line (team-route.ts says where the runs go). The lines stay one screen pixel at any zoom,
// and every point lands on a whole screen pixel, as the sidebar's wire does. It sits in the
// canvas's viewport beneath the windows, so it pans, zooms and follows a dragged window with
// them, and is only drawn: it takes no pointer. The lines are simply there. Selecting a
// member of a team plays that team's pulse alone (the sidebar's, team-wire.css): the cursor
// blinks and one light leaves the lead along the runs to each worker. A wire recedes with
// its windows unless its team is the selected one.
export const CanvasTeamWire = ({
  teams,
  team,
  selected,
}: {
  teams: readonly Team[]
  // The selected terminal's team, if it has one: the one whose pulse plays and whose wire
  // doesn't recede.
  team: Team | undefined
  selected: string
}): React.JSX.Element | null =>
  // Mounted only while there is a team, so that no pan or zoom renders anything without one.
  teams.length ? <TeamWires teams={teams} team={team} selected={selected} /> : null

const TeamWires = ({
  teams,
  team,
  selected,
}: {
  teams: readonly Team[]
  team: Team | undefined
  selected: string
}): React.JSX.Element => {
  const ids = useMemo(
    () => [...new Set(teams.flatMap((each) => [each.lead, ...each.workers]))],
    [teams],
  )
  // The rect of each member of any team that is on the canvas, as one string, so that this
  // renders only when one moves or resizes, and not on each update of the store. Read once
  // for every team, not once for each.
  const members = useStore(
    useCallback(
      (state: ReactFlowState) =>
        JSON.stringify(
          ids.flatMap((id) => {
            const node = state.nodeLookup.get(id)
            if (!node || node.hidden || (node.data as Partial<TerminalNode["data"]>).hiding)
              return []
            const { x: left, y: top } = node.internals.positionAbsolute
            const width = node.measured.width ?? node.width ?? 0
            const height = node.measured.height ?? node.height ?? 0
            return [[id, left, top, width, height]]
          }),
        ),
      [ids],
    ),
  )
  const x = useStore((state) => state.transform[0])
  const y = useStore((state) => state.transform[1])
  const zoom = useStore((state) => state.transform[2])
  const rects = useMemo(
    () =>
      new Map(
        (JSON.parse(members) as [string, number, number, number, number][]).map(
          ([id, rx, ry, width, height]): [string, Member] => [
            id,
            { id, x: rx, y: ry, width, height },
          ],
        ),
      ),
    [members],
  )
  return (
    <ViewportPortal>
      {teams.map((each) => (
        <TeamWireOf
          key={each.lead}
          team={each}
          rects={rects}
          view={{ x, y, zoom }}
          selected={selected}
          active={team?.lead === each.lead}
        />
      ))}
    </ViewportPortal>
  )
}

const TeamWireOf = ({
  team,
  rects,
  view,
  selected,
  active,
}: {
  team: Team
  // Where each team member on the canvas is, in its units, and where the camera is.
  rects: ReadonlyMap<string, Member>
  view: { readonly x: number; readonly y: number; readonly zoom: number }
  selected: string
  // Whether this is the selected terminal's team.
  active: boolean
}): React.JSX.Element | null => {
  const { x, y, zoom } = view
  // The last selection of a member of this team, whose pulse plays, and the one that has
  // played.
  const [pulse, setPulse] = useState<string | undefined>(undefined)
  const [played, setPlayed] = useState<string | undefined>(undefined)
  // Leaving the team forgets the pulse, so each selection into it plays once.
  if (active && pulse !== selected) setPulse(selected)
  if (!active && (pulse !== undefined || played !== undefined)) {
    setPulse(undefined)
    setPlayed(undefined)
  }
  useEffect(() => {
    if (pulse === undefined) return
    const timer = setTimeout(() => setPlayed(pulse), blinkMs + 900)
    return () => clearTimeout(timer)
  }, [pulse])
  const pulsing = pulse !== undefined && played !== pulse

  // The pulse's timing is set by the zoom as the selection is made, so zooming while it
  // plays doesn't make it jump.
  const [timed, setTimed] = useState({ pulse, zoom })
  if (timed.pulse !== pulse) setTimed({ pulse, zoom })

  const route = useMemo(() => {
    const present = [team.lead, ...team.workers].flatMap((id) => rects.get(id) ?? [])
    return teamRoute(
      present.find((rect) => rect.id === team.lead),
      present.filter((rect) => rect.id !== team.lead),
      // Under the window's 1px border, half way down its header.
      1 + (terminalHeaderHeight * chromeScaleAt(zoom)) / 2,
    )
  }, [team, rects, zoom])
  if (!route) return null

  // World to screen pixel, whole, and back: a line drawn at the result is one crisp pixel.
  const px = (world: number, offset: number) => Math.round(world * zoom + offset)
  const back = (screen: number, offset: number) => (screen - offset) / zoom
  const at = (point: Point) => ({ x: px(point.x, x), y: px(point.y, y) })
  const along = (point: Point) => ({
    x: back(px(point.x, x) + 0.5, x),
    y: back(px(point.y, y) + 0.5, y),
  })
  const one = 1 / zoom
  const horizontal = ({ from, to }: Run): CSSProperties => {
    const a = at(from)
    const b = at(to)
    return {
      left: back(Math.min(a.x, b.x), x),
      top: back(a.y, y),
      width: Math.abs(b.x - a.x) / zoom,
      height: one,
    }
  }
  const vertical = ({ from, to }: Run): CSSProperties => {
    const a = at(from)
    const b = at(to)
    return {
      left: back(a.x, x),
      top: back(Math.min(a.y, b.y), y),
      width: one,
      height: (Math.abs(b.y - a.y) + 1) / zoom,
    }
  }
  // The pulse runs at one speed along every path, the longest taking as long as the sidebar's
  // pulse takes over a stretch as long.
  const longest = Math.max(1, ...route.paths.map((path) => path.length))
  const total = Math.min(700, 260 + longest * timed.zoom * 0.8)
  const duration = (length: number) => total * (length / longest)
  return (
    <div
      className="canvas-team-wire"
      aria-hidden
      data-selected={active || undefined}
      data-pulsing={pulsing || undefined}
      style={{ "--team-wire-blink": `${blinkMs}ms` } as CSSProperties}
    >
      <div className="canvas-team-wire-shape">
        {route.sides.map(({ side, stem }) => (
          <i key={`stem-${side}`} className="canvas-team-wire-line" style={horizontal(stem)} />
        ))}
        {route.sides.map(({ side, trunk }) => (
          <i key={`trunk-${side}`} className="canvas-team-wire-line" style={vertical(trunk)} />
        ))}
        {route.ticks.map((tick) => (
          <i
            key={`tick-${tick.id}`}
            className="canvas-team-wire-line canvas-team-wire-tick"
            data-to={tick.run.to.x >= tick.run.from.x ? "right" : "left"}
            style={horizontal(tick.run)}
          />
        ))}
        {route.sides.map(({ side, cursor }) => {
          const point = at(cursor)
          // Wholly outside the lead's edge, touching it, on the side the wire leaves by.
          const left = side === "right" ? point.x : point.x - 5
          return (
            <i
              key={`cursor-${side}-${pulse}`}
              className="canvas-team-wire-cursor"
              style={{
                left: back(left, x),
                top: back(point.y - 4, y),
                width: 5 / zoom,
                height: 8 / zoom,
              }}
            />
          )
        })}
        {pulsing &&
          route.paths.map((path) => (
            <i
              key={`pulse-${path.id}-${pulse}`}
              className="canvas-team-wire-pulse"
              style={
                {
                  "--_path": `path("${path.points
                    .map((point, index) => {
                      const { x: wx, y: wy } = along(point)
                      return `${index ? "L" : "M"} ${wx} ${wy}`
                    })
                    .join(" ")}")`,
                  "--_duration": `${duration(path.length)}ms`,
                  width: streakLength / zoom,
                  height: 3 / zoom,
                } as CSSProperties
              }
            />
          ))}
      </div>
    </div>
  )
}
