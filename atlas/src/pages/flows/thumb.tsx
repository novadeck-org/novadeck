import type { Flow } from "../../atlas.ts"

export const actorsOf = (flow: Flow) => [
  ...new Set([...flow.actors, ...flow.steps.flatMap((s) => [s.from, s.to])]),
]

// A flow in miniature: actors as dotted lifelines, one short arrow per step.
export const Thumb = ({ flow }: { flow: Flow }) => {
  const actors = actorsOf(flow)
  const GAP = 26
  const ROW = 9
  const width = 16 + (actors.length - 1) * GAP + 16
  const height = 18 + flow.steps.length * ROW + 6
  const x = (id: string) => 16 + actors.indexOf(id) * GAP
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height * 1.5}
      className="block"
      preserveAspectRatio="xMidYMin meet"
    >
      {actors.map((a) => (
        <g key={a}>
          <line
            x1={x(a)}
            x2={x(a)}
            y1={8}
            y2={height - 4}
            stroke="var(--line)"
            strokeDasharray="1.5 2"
          />
          <circle cx={x(a)} cy={6} r={2.6} fill="var(--color-line-strong)" />
        </g>
      ))}
      {flow.steps.map((s, i) => {
        const y = 16 + i * ROW
        return s.from === s.to ? (
          <rect
            key={`${s.from}${s.to}${s.text}`}
            x={x(s.from)}
            y={y - 2.5}
            width={5}
            height={5}
            fill="none"
            stroke="var(--color-line-strong)"
            strokeWidth={1}
          />
        ) : (
          <g key={`${s.from}${s.to}${s.text}`}>
            <line
              x1={x(s.from)}
              x2={x(s.to)}
              y1={y}
              y2={y}
              stroke="var(--color-line-strong)"
              strokeWidth={1.2}
            />
            <circle cx={x(s.to)} cy={y} r={1.8} fill="var(--color-line-strong)" />
          </g>
        )
      })}
    </svg>
  )
}
