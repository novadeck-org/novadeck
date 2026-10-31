import { clsx } from "clsx"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { atlas, nodeById } from "../atlas-data.ts"
import type { AreaLink } from "../atlas.ts"

// Muted category hues per runtime node; the tokens live at the end of index.css.
export const hue = (node: string) => ({
  fill: `var(--hue-${nodeById.has(node) ? node : "github"})`,
  ink: `var(--hue-${nodeById.has(node) ? node : "github"}-ink)`,
})

export const compact = (n: number) =>
  n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`

export const links: AreaLink[] = atlas.links

export const kindDash: Record<AreaLink["kind"], string | undefined> = {
  import: undefined,
  call: "7 4",
  data: "1.5 4",
}

export const strokeFor = (weight: number) => 1 + Math.min(5, Math.log2(weight + 1) * 0.9)

export const useSize = <T extends HTMLElement>() => {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setSize({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return { ref, ...size }
}

export const Segmented = <T extends string>({
  value,
  options,
  onChange,
  floating = false,
}: {
  value: T
  options: { id: T; label: string; icon?: ReactNode }[]
  onChange: (id: T) => void
  // Standing on the workspace rather than in a pane, it lifts off it.
  floating?: boolean
}) => (
  <div className={floating ? "segmented gap-0.5 shadow-lg" : "segmented gap-0.5"}>
    {options.map((o) => (
      <button
        key={o.id}
        type="button"
        aria-pressed={o.id === value}
        onClick={() => onChange(o.id)}
        className="segment h-7 gap-1.5 px-2.5 text-control"
      >
        {o.icon}
        {o.label}
      </button>
    ))}
  </div>
)

export const Dot = ({ node, size = 8 }: { node: string; size?: number }) => (
  <span
    className="inline-block shrink-0 rounded-full"
    style={{ width: size, height: size, background: hue(node).ink }}
  />
)

// A line sample for a link kind, for legends.
export const KindSample = ({ kind }: { kind: AreaLink["kind"] }) => (
  <svg width="26" height="8" aria-hidden>
    <line
      x1="1"
      x2="25"
      y1="4"
      y2="4"
      stroke="var(--color-line-strong)"
      strokeWidth="2"
      strokeDasharray={kindDash[kind]}
      strokeLinecap="round"
    />
  </svg>
)

// An area's token, as the team says it: the path to it quiet, its own segment plain.
// `within` drops a leading part the surroundings already name, as a treemap group does.
export const Token = ({
  id,
  within,
  className,
}: {
  id: string
  within?: string
  className?: string
}) => {
  const shown = within && id.startsWith(`${within}/`) ? id.slice(within.length + 1) : id
  const at = shown.lastIndexOf("/")
  return (
    <span className={clsx("font-mono", className)}>
      {at === -1 ? null : <span className="text-muted">{shown.slice(0, at + 1)}</span>}
      {shown.slice(at + 1)}
    </span>
  )
}

// A label cut to n characters, with an ellipsis where it was.
export const clip = (text: string, n: number) =>
  text.length > n ? `${text.slice(0, n - 1)}…` : text
