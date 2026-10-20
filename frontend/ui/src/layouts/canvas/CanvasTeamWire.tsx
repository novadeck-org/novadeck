import type { Team } from "@novadeck/core/derivations"
import { useStore, ViewportPortal, type ReactFlowState } from "@xyflow/react"
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react"

import { blinkMs } from "../../terminals/team-wire"
import { chromeScaleAt, terminalHeaderHeight } from "./geometry"
import { teamRoute, type Member, type Point, type Run } from "./team-route"
import type { TerminalNode } from "./types"

// A drawn pulse's streak is this long on the screen, in pixels.
const streakLength = 28

// The selected terminal's team on the canvas: while the lead's window and a worker's are on
// it, a block cursor on the lead's edge at its header line, a line out to a trunk that runs
// past every worker, and a tick into each worker's edge at its header line (team-route.ts
// says where the runs go). The lines stay one screen pixel at any zoom, and every point
// lands on a whole screen pixel, as the sidebar's wire does. It sits in the canvas's
// viewport beneath the windows, so it pans, zooms and follows a dragged window with them,
// and is only drawn: it takes no pointer. The motion is the sidebar's (team-wire.css): the
// wire draws in, the cursor blinks, one pulse leaves the lead for each worker and lights
// its tick, and once it has played, redraws never play it again.
export const CanvasTeamWire = ({
  team,
  selected,
}: {
  team: Team | undefined
  selected: string
}): React.JSX.Element | null =>
  // Mounted only for a team, so that no pan or zoom renders this for a terminal without one.
  team ? <TeamWireOf team={team} selected={selected} /> : null

const TeamWireOf = ({
  team,
  selected,
}: {
  team: Team
  selected: string
}): React.JSX.Element | null => {
  const ids = useMemo(() => [team.lead, ...team.workers], [team])
  // The rect of each member that is on the canvas, as one string, so that this renders only
  // when a member moves or resizes, and not on each update of the store.
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
  // The selection whose pulse has played.
  const [played, setPlayed] = useState<string | undefined>(undefined)
  useEffect(() => {
    const timer = setTimeout(() => setPlayed(selected), blinkMs + 900)
    return () => clearTimeout(timer)
  }, [selected])

  // The pulse's timing is set by the zoom as the selection is made, so zooming while it
  // plays doesn't make it jump.
  const [timed, setTimed] = useState({ selected, zoom })
  if (timed.selected !== selected) setTimed({ selected, zoom })

  const route = useMemo(() => {
    const rects = (JSON.parse(members) as [string, number, number, number, number][]).map(
      ([id, rx, ry, width, height]): Member => ({
        id,
        x: rx,
        y: ry,
        width,
        height,
      }),
    )
    return teamRoute(
      rects.find((rect) => rect.id === team.lead),
      rects.filter((rect) => rect.id !== team.lead),
      // Under the window's 1px border, half way down its header.
      1 + (terminalHeaderHeight * chromeScaleAt(zoom)) / 2,
    )
  }, [team, members, zoom])
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
  const tickAt = (id: string) => {
    const path = route.paths.find((item) => item.id === id)
    const tick = route.ticks.find((item) => item.id === id)
    if (!path || !tick || !path.length) return blinkMs
    const run = Math.abs(tick.run.to.x - tick.run.from.x)
    return Math.round(blinkMs + duration(path.length) * ((path.length - run) / path.length))
  }

  return (
    <ViewportPortal>
      <div
        className="canvas-team-wire"
        aria-hidden
        data-settled={played === selected || undefined}
        style={{ "--team-wire-blink": `${blinkMs}ms` } as CSSProperties}
      >
        <div key={selected} className="canvas-team-wire-shape">
          {route.sides.map(({ side, stem }) => (
            <i
              key={`stem-${side}`}
              className="canvas-team-wire-line canvas-team-wire-stem"
              style={
                {
                  ...horizontal(stem),
                  "--_origin": side === "right" ? "left" : "right",
                } as CSSProperties
              }
            />
          ))}
          {route.sides.map(({ side, trunk }) => (
            <i
              key={`trunk-${side}`}
              className="canvas-team-wire-line canvas-team-wire-trunk"
              style={vertical(trunk)}
            />
          ))}
          {route.ticks.map((tick) => (
            <i
              key={`tick-${tick.id}`}
              className="canvas-team-wire-line canvas-team-wire-tick"
              data-to={tick.run.to.x >= tick.run.from.x ? "right" : "left"}
              style={
                {
                  ...horizontal(tick.run),
                  "--_at": `${tickAt(tick.id)}ms`,
                } as CSSProperties
              }
            />
          ))}
          {route.sides.map(({ side, cursor }) => {
            const point = at(cursor)
            // Wholly outside the lead's edge, touching it, on the side the wire leaves by.
            const left = side === "right" ? point.x : point.x - 5
            return (
              <i
                key={`cursor-${side}`}
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
          {route.paths.map((path) => (
            <i
              key={`pulse-${path.id}`}
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
    </ViewportPortal>
  )
}
