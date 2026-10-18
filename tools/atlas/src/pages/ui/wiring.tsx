import type { BoxId } from "../../lens-ui.ts"
import { lens, type Lit, type Selection, untracedStreams } from "./model.ts"

// The wiring diagram: where state lives and how a call goes out and comes back, drawn on
// a fixed grid so the arrows can be placed by hand. Sizes are in viewBox units.
const W = 1280
const H = 334
const BW = 188
const BH = 56
const col = (n: number) => 16 + n * 264
const Y0 = 20

type Place = { x: number; y: number; h?: number; side: "ui" | "protocol" | "runner" }

const places: Record<BoxId, Place> = {
  commands: { x: col(0), y: Y0 + 28, side: "ui" },
  ui: { x: col(1), y: Y0, h: 50, side: "ui" },
  workspace: { x: col(1), y: Y0 + 58, h: 50, side: "ui" },
  components: { x: col(2), y: Y0 + 28, side: "ui" },
  port: { x: col(1), y: 158, side: "ui" },
  adapter: { x: col(2), y: 158, side: "ui" },
  procedures: { x: col(3), y: 158, side: "protocol" },
  runner: { x: col(4), y: 158, side: "runner" },
  feature: { x: col(0), y: 246, side: "ui" },
  sink: { x: col(1), y: 246, side: "ui" },
  consumers: { x: col(2), y: 246, side: "ui" },
  streams: { x: col(3), y: 246, side: "runner" },
}

const right = (id: BoxId) => places[id].x + BW
const left = (id: BoxId) => places[id].x
const top = (id: BoxId) => places[id].y
const bottom = (id: BoxId) => places[id].y + (places[id].h ?? BH)
const mid = (id: BoxId) => places[id].y + (places[id].h ?? BH) / 2
const center = (id: BoxId) => places[id].x + BW / 2

type Edge = {
  id: string
  from: BoxId
  to: BoxId
  d: string
  label?: string
  at?: [number, number]
  back?: boolean
}

const edges: Edge[] = [
  {
    id: "calls",
    from: "components",
    to: "commands",
    d: `M${center("components")},${top("components")} C${center("components")},${Y0 - 22} ${center("commands")},${Y0 - 22} ${center("commands")},${top("commands")}`,
    label: "event handlers call commands",
    at: [(center("components") + center("commands")) / 2, Y0 - 12],
  },
  {
    id: "dispatch",
    from: "commands",
    to: "workspace",
    d: `M${right("commands")},${mid("commands") + 8} C${right("commands") + 36},${mid("commands") + 8} ${left("workspace") - 36},${mid("workspace") - 10} ${left("workspace")},${mid("workspace") - 10}`,
    label: "dispatch",
    at: [right("commands") + 32, mid("commands") + 34],
  },
  {
    id: "update",
    from: "commands",
    to: "ui",
    d: `M${right("commands")},${mid("commands") - 8} C${right("commands") + 36},${mid("commands") - 8} ${left("ui") - 36},${mid("ui")} ${left("ui")},${mid("ui")}`,
    label: "update",
    at: [right("commands") + 32, mid("ui") - 2],
  },
  {
    id: "select-ws",
    from: "workspace",
    to: "components",
    d: `M${right("workspace")},${mid("workspace") - 8} C${right("workspace") + 32},${mid("workspace") - 8} ${left("components") - 32},${mid("components") + 12} ${left("components")},${mid("components") + 12}`,
    label: "select",
    at: [right("workspace") + 32, mid("workspace") + 6],
  },
  {
    id: "select-ui",
    from: "ui",
    to: "components",
    d: `M${right("ui")},${mid("ui")} C${right("ui") + 32},${mid("ui")} ${left("components") - 32},${mid("components") - 4} ${left("components")},${mid("components") - 4}`,
  },
  {
    id: "commit",
    from: "workspace",
    to: "port",
    d: `M${center("workspace")},${bottom("workspace")} L${center("port")},${top("port")}`,
    label: "commit hook, every commit",
    at: [center("port") + 84, (bottom("workspace") + top("port")) / 2 + 4],
  },
  {
    id: "to-adapter",
    from: "port",
    to: "adapter",
    d: `M${right("port")},${mid("port")} L${left("adapter")},${mid("port")}`,
  },
  {
    id: "to-procedures",
    from: "adapter",
    to: "procedures",
    d: `M${right("adapter")},${mid("adapter")} L${left("procedures")},${mid("adapter")}`,
    label: "calls",
    at: [right("adapter") + 32, mid("adapter") - 6],
  },
  {
    id: "to-runner",
    from: "procedures",
    to: "runner",
    d: `M${right("procedures")},${mid("procedures")} L${left("runner")},${mid("procedures")}`,
    label: "WebSocket",
    at: [right("procedures") + 32, mid("procedures") - 6],
  },
  {
    id: "runner-streams",
    from: "runner",
    to: "streams",
    d: `M${center("runner")},${bottom("runner")} L${center("runner")},${mid("streams")} L${right("streams")},${mid("streams")}`,
    back: true,
    label: "events",
    at: [center("runner") - 56, mid("streams") - 6],
  },
  {
    id: "streams-consumers",
    from: "streams",
    to: "consumers",
    d: `M${left("streams")},${mid("streams")} L${right("consumers")},${mid("streams")}`,
    back: true,
  },
  {
    id: "consumers-sink",
    from: "consumers",
    to: "sink",
    d: `M${left("consumers")},${mid("consumers")} L${right("sink")},${mid("consumers")}`,
    back: true,
    label: "dispatch",
    at: [right("sink") + 32, mid("consumers") - 6],
  },
  {
    id: "sink-workspace",
    from: "sink",
    to: "workspace",
    d: `M${left("sink")},${mid("sink")} L${left("sink") - 16},${mid("sink")} L${left("sink") - 16},${mid("workspace") + 12} L${left("workspace")},${mid("workspace") + 12}`,
    back: true,
  },
  {
    id: "consumers-feature",
    from: "consumers",
    to: "feature",
    d: `M${center("consumers")},${bottom("consumers")} L${center("consumers")},${H - 16} L${center("feature")},${H - 16} L${center("feature")},${bottom("feature")}`,
    back: true,
    label: "store.update",
    at: [center("sink"), H - 4],
  },
]

// What the scan could not close, for a box that carries a count of the traced.
const gaps = (id: BoxId): string | null => {
  if (id === "streams") {
    const open = untracedStreams().length
    return open ? `${open} untraced` : null
  }
  if (id === "consumers") {
    const unresolved = lens.streams.length - lens.streams.filter((stream) => stream.handler).length
    return unresolved ? `${unresolved} not found` : null
  }
  return null
}

export const Wiring = ({
  selection,
  lit,
  onSelect,
}: {
  selection: Selection
  lit: Lit
  onSelect: (id: BoxId) => void
}) => {
  const active = selection !== null
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="mx-auto block h-auto max-h-[326px] w-full font-sans"
      role="group"
      aria-label="How state and calls are wired in the UI"
    >
      <defs>
        <marker
          id="uw-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0 0L10 5L0 10z" fill="context-stroke" />
        </marker>
      </defs>
      <g>
        <line
          x1={col(0)}
          x2={col(0) + 40}
          y1={mid("port") - 14}
          y2={mid("port") - 14}
          className="uw-edge"
          markerEnd="url(#uw-arrow)"
        />
        <text x={col(0) + 50} y={mid("port") - 10} className="uw-note">
          out: a commit to the runner
        </text>
        <line
          x1={col(0)}
          x2={col(0) + 40}
          y1={mid("port") + 6}
          y2={mid("port") + 6}
          className="uw-edge"
          data-back="true"
          markerEnd="url(#uw-arrow)"
        />
        <text x={col(0) + 50} y={mid("port") + 10} className="uw-note">
          back: events become actions
        </text>
        <line
          x1={col(0)}
          x2={col(0) + 40}
          y1={mid("port") + 26}
          y2={mid("port") + 26}
          className="uw-edge"
          data-lit="2"
        />
        <text x={col(0) + 50} y={mid("port") + 30} className="uw-note">
          bold: the path you picked
        </text>
        <rect
          x={col(0)}
          y={mid("port") + 38}
          width={40}
          height={10}
          rx={2}
          className="uw-key-gap"
        />
        <text x={col(0) + 50} y={mid("port") + 47} className="uw-note">
          warning outline: not traced
        </text>
      </g>
      {edges.map((edge) => {
        const level = Math.min(lit.get(edge.from) ?? 0, lit.get(edge.to) ?? 0)
        return (
          <g key={edge.id}>
            <path
              d={edge.d}
              className="uw-edge"
              data-back={edge.back ? "true" : undefined}
              data-lit={level}
              data-dim={active && level === 0 ? "true" : undefined}
              markerEnd="url(#uw-arrow)"
            />
            {edge.label && edge.at ? (
              <text x={edge.at[0]} y={edge.at[1]} textAnchor="middle" className="uw-label">
                {edge.label}
              </text>
            ) : null}
          </g>
        )
      })}
      {lens.boxes.map((box) => {
        const place = places[box.id]
        const h = place.h ?? BH
        const level = lit.get(box.id) ?? 0
        const selected = selection?.kind === "box" && selection.id === box.id
        const gap = gaps(box.id)
        return (
          <g
            key={box.id}
            className="uw-box"
            transform={`translate(${place.x} ${place.y})`}
            tabIndex={0}
            role="button"
            aria-pressed={selected}
            aria-label={`${box.title}: ${box.count} ${box.unit}`}
            data-lit={level}
            data-selected={selected}
            data-gap={gap ? "true" : undefined}
            data-dim={active && level === 0 && !selected ? "true" : undefined}
            onClick={() => onSelect(box.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault()
                onSelect(box.id)
              }
            }}
          >
            <rect className="face" width={BW} height={h} rx={3} />
            <rect className="bar" x={0} y={h * 0.25} width={2} height={h * 0.5} />
            <circle cx={14} cy={16} r={3.5} fill={`var(--g-${place.side})`} />
            <text x={24} y={19} className="uw-title">
              {box.title}
            </text>
            <text x={12} y={h - 9} className="uw-count" fontSize={h < BH ? 18 : undefined}>
              {box.count}
            </text>
            <text
              x={12 + String(box.count).length * (h < BH ? 11 : 13.5) + 6}
              y={h - 10}
              className="uw-unit"
            >
              {box.unit}
            </text>
            {gap ? (
              <text x={BW - 10} y={h - 12} textAnchor="end" className="uw-gap">
                {gap}
              </text>
            ) : null}
          </g>
        )
      })}
    </svg>
  )
}
