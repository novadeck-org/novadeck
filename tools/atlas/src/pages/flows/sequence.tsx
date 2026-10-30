import { useState } from "react"

import { nodeTitle } from "../../atlas-data.ts"
import type { Flow } from "../../atlas.ts"
import { AnchorIcon, AnchorLink } from "../../components/anchor.tsx"
import { clip } from "../../components/viz.tsx"
import { actorsOf } from "./thumb.tsx"

const COL = 190
const TOP = 60
const ROW = 46
const LEFT = 24

export const Sequence = ({ flow }: { flow: Flow }) => {
  const [pinned, setPinned] = useState<number | null>(null)
  const [hover, setHover] = useState<number | null>(null)
  const active = hover ?? pinned
  const actors = actorsOf(flow)
  const x = (id: string) => LEFT + COL / 2 + actors.indexOf(id) * COL
  const width = LEFT * 2 + actors.length * COL + 110
  const height = TOP + flow.steps.length * ROW + 12
  const step = active === null ? null : flow.steps[active]
  return (
    <div className="space-y-3">
      <div className="overflow-auto">
        <svg
          width={width}
          height={height}
          className="block font-sans text-[12px]"
          role="img"
          aria-label={flow.title}
        >
          <defs>
            <marker
              id="arrow"
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
          {actors.map((id) => (
            <g key={id}>
              <line
                x1={x(id)}
                x2={x(id)}
                y1={40}
                y2={height - 6}
                stroke="var(--color-line-strong)"
                strokeOpacity={0.5}
                strokeDasharray="4 4"
              />
              <rect
                x={x(id) - 78}
                y={8}
                width={156}
                height={28}
                fill="var(--panel)"
                stroke="var(--window-border-color)"
                rx={2}
              />
              <text x={x(id)} y={26} textAnchor="middle" fill="var(--fg)" fontWeight={600}>
                {nodeTitle(id)}
              </text>
            </g>
          ))}
          {flow.steps.map((s, i) => {
            const y = TOP + i * ROW + 20
            const a = x(s.from)
            const b = x(s.to)
            const on = active === i
            const color = on ? "var(--accent)" : "var(--fg)"
            const self = s.from === s.to
            const mid = (a + b) / 2
            return (
              <g
                key={`${s.from}-${s.to}-${s.text}`}
                className="cursor-pointer"
                onMouseEnter={() => setHover(i)}
                onMouseLeave={() => setHover(null)}
                onClick={() => setPinned(pinned === i ? null : i)}
              >
                <rect
                  x={Math.min(a, b) - 8}
                  y={y - 26}
                  width={Math.abs(b - a) + (self ? 240 : 16)}
                  height={34}
                  fill="transparent"
                />
                {self ? (
                  <>
                    <path
                      d={`M${a} ${y - 8}H${a + 30}V${y + 8}H${a + 3}`}
                      fill="none"
                      stroke={color}
                      markerEnd="url(#arrow)"
                    />
                    <text x={a + 38} y={y + 4} fill={color}>
                      <tspan fontWeight={600}>{i + 1}</tspan> {clip(s.label, 28)}
                    </text>
                  </>
                ) : (
                  <>
                    <line
                      x1={a}
                      x2={b}
                      y1={y}
                      y2={y}
                      stroke={color}
                      strokeWidth={on ? 2 : 1.2}
                      markerEnd="url(#arrow)"
                    />
                    <text x={mid} y={y - 7} textAnchor="middle" fill={color}>
                      <tspan fontWeight={600}>{i + 1}</tspan>{" "}
                      {clip(s.label, Math.max(10, Math.floor((Math.abs(b - a) - 28) / 6.3)))}
                    </text>
                  </>
                )}
              </g>
            )
          })}
        </svg>
      </div>
      <div className="pane floating min-h-14 max-w-3xl px-3 py-2 text-[13px]">
        {step ? (
          <div className="flex items-start gap-3">
            <span className="font-mono text-[12px] text-accent">{(active ?? 0) + 1}</span>
            <div className="min-w-0 flex-1">
              <div className="text-[11px] text-muted">
                {nodeTitle(step.from)} to {nodeTitle(step.to)}
              </div>
              <p>{step.text}</p>
              <div className="mt-0.5 text-[11px]">
                {pinned === active ? <AnchorLink anchor={step.anchor} /> : null}
              </div>
            </div>
            <AnchorIcon anchor={step.anchor} />
          </div>
        ) : (
          <span className="text-[12px] text-muted">Hover or click an arrow.</span>
        )}
      </div>
    </div>
  )
}
