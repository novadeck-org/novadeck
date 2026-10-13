import { useState } from "react"
import { useNavigate } from "react-router"

import { areaById } from "../../atlas-data.ts"
import type { AreaLink } from "../../atlas.ts"
import { hue, kindDash, links, strokeFor } from "../../components/viz.tsx"
import { areaPath } from "../../links.ts"

const W = 680
const BOX_W = 190
const BOX_H = 24
const ROW = 32

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// This area in the middle, what it depends on to the left, what depends on it to the right.
export const EgoGraph = ({ id }: { id: string }) => {
  const navigate = useNavigate()
  const [hover, setHover] = useState<string | null>(null)
  const out = links.filter((l) => l.from === id && l.to !== id)
  const into = links.filter((l) => l.to === id && l.from !== id)
  const left = [...new Set(out.map((l) => l.to))]
  const right = [...new Set(into.map((l) => l.from))]
  if (left.length + right.length === 0) return null

  const rows = Math.max(left.length, right.length, 1)
  const H = rows * ROW + 8
  const mid = H / 2
  const slot = (list: string[], other: string) =>
    (H - list.length * ROW) / 2 + list.indexOf(other) * ROW + ROW / 2
  const cx = (W - BOX_W) / 2

  const box = (x: number, y: number, area: string) => {
    const a = areaById.get(area)
    return (
      <g
        key={area}
        className="cursor-pointer"
        onClick={() => navigate(areaPath(area))}
        onMouseEnter={() => setHover(area)}
        onMouseLeave={() => setHover(null)}
      >
        <rect
          x={x}
          y={y - BOX_H / 2}
          width={BOX_W}
          height={BOX_H}
          rx={3}
          fill="var(--panel)"
          stroke={hover === area ? "var(--accent)" : "var(--window-border-color)"}
        />
        <rect x={x} y={y - BOX_H / 2} width={4} height={BOX_H} fill={hue(a?.node ?? "").ink} />
        <text x={x + 12} y={y + 4} fontSize={12} fontFamily="var(--font-mono)" fill="var(--fg)">
          {clip(area, 26)}
        </text>
      </g>
    )
  }

  const path = (l: AreaLink, x1: number, y1: number, x2: number, y2: number) => {
    const m = (x1 + x2) / 2
    return (
      <path
        key={`${l.kind}:${l.from}>${l.to}`}
        d={`M${x1},${y1} C${m},${y1} ${m},${y2} ${x2},${y2}`}
        fill="none"
        stroke="var(--color-line-strong)"
        strokeWidth={strokeFor(l.weight)}
        strokeDasharray={kindDash[l.kind]}
        opacity={hover && hover !== l.to && hover !== l.from ? 0.15 : 0.8}
      >
        <title>
          {l.kind} x{l.weight}
        </title>
      </path>
    )
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[680px]" role="img">
      {out.map((l) =>
        path(
          l,
          cx,
          mid + 0,
          BOX_W,
          slot(left, l.to) + (l.kind === "data" ? 4 : l.kind === "call" ? 2 : 0),
        ),
      )}
      {into.map((l) =>
        path(
          l,
          W - BOX_W,
          slot(right, l.from) + (l.kind === "data" ? 4 : l.kind === "call" ? 2 : 0),
          cx + BOX_W,
          mid,
        ),
      )}
      {left.map((a) => box(0, slot(left, a), a))}
      {right.map((a) => box(W - BOX_W, slot(right, a), a))}
      <g>
        <rect
          x={cx}
          y={mid - BOX_H / 2 - 2}
          width={BOX_W}
          height={BOX_H + 4}
          rx={3}
          fill="var(--panel)"
          stroke="var(--accent)"
          strokeWidth={1.5}
        />
        <text
          x={cx + 12}
          y={mid + 4}
          fontSize={12}
          fontWeight={600}
          fontFamily="var(--font-mono)"
          fill="var(--fg)"
        >
          {clip(id, 26)}
        </text>
      </g>
    </svg>
  )
}
