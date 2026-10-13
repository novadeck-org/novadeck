import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import { clsx } from "clsx"
import { useMemo, useState } from "react"
import { useNavigate } from "react-router"

import { atlas, nodeTitle } from "../../atlas-data.ts"
import type { Area, AreaLink } from "../../atlas.ts"
import {
  compact,
  Dot,
  hue,
  KindSample,
  kindDash,
  links,
  strokeFor,
  Token,
} from "../../components/viz.tsx"
import { areaPath } from "../../links.ts"

// Columns follow the data's path: renderer, then electron, then the runner, then
// relay/agent side, then engines.
const COLUMN: Record<string, number> = {
  renderer: 0,
  preload: 1,
  "electron-main": 1,
  runner: 2,
  relay: 3,
  agent: 3,
  whisper: 4,
  murmur: 4,
}
const COLUMN_NAMES = ["Renderer", "Electron", "Runner", "Relay", "Engines"]
const COL_W = 230
const NODE_W = 168
const ROW_H = 38

const maxLines = Math.max(1, ...atlas.areas.map((a) => a.lines))

type AreaData = { area: Area; dim: boolean }
type AreaNode = Node<AreaData, "area">
type LabelNode = Node<{ label: string }, "label">

const AreaCard = ({ data }: NodeProps<AreaNode>) => (
  <div
    className={clsx("pane px-2 py-0.5 transition-opacity", data.dim && "opacity-25")}
    style={{ width: NODE_W, borderLeft: `3px solid ${hue(data.area.node).ink}` }}
  >
    <Token id={data.area.id} className="block truncate text-[12px] leading-4" />
    <div
      className="mt-0.5 h-[3px] rounded-full"
      style={{
        width: `${Math.max(4, (Math.sqrt(data.area.lines / maxLines) * 100) | 0)}%`,
        background: "var(--color-line-strong)",
      }}
    />
    <Handle id="l" type="target" position={Position.Left} className="!opacity-0" />
    <Handle id="r" type="source" position={Position.Right} className="!opacity-0" />
    <Handle id="lr" type="source" position={Position.Left} className="!opacity-0" />
    <Handle id="rl" type="target" position={Position.Right} className="!opacity-0" />
  </div>
)

const ColumnLabel = ({ data }: NodeProps<LabelNode>) => (
  <div
    className="font-mono text-[10px] uppercase tracking-wider text-muted"
    style={{ width: NODE_W }}
  >
    {data.label}
  </div>
)

const nodeTypes = { area: AreaCard, label: ColumnLabel }

const kinds: AreaLink["kind"][] = ["import", "call", "data"]

export const GraphView = () => {
  const navigate = useNavigate()
  const [hover, setHover] = useState<string | null>(null)
  const [shown, setShown] = useState<Set<AreaLink["kind"]>>(new Set(kinds))

  const layout = useMemo(() => {
    const cols: Area[][] = COLUMN_NAMES.map(() => [])
    for (const a of atlas.areas) cols[COLUMN[a.node] ?? 4]!.push(a)
    const byNode = (a: Area, b: Area) => a.node.localeCompare(b.node) || b.lines - a.lines
    const nodes: (AreaNode | LabelNode)[] = []
    const column = new Map<string, number>()
    cols.forEach((col, ci) => {
      nodes.push({
        id: `col-${ci}`,
        type: "label",
        position: { x: ci * COL_W, y: -26 },
        data: { label: COLUMN_NAMES[ci]! },
        selectable: false,
        draggable: false,
      })
      col.toSorted(byNode).forEach((area, ri) => {
        column.set(area.id, ci)
        nodes.push({
          id: area.id,
          type: "area",
          position: { x: ci * COL_W, y: ri * ROW_H },
          data: { area, dim: false },
        })
      })
    })
    return { nodes, column }
  }, [])

  const visible = links.filter((l) => shown.has(l.kind) && l.from !== l.to)
  const touches = (id: string) =>
    new Set([id, ...visible.flatMap((l) => (l.from === id || l.to === id ? [l.from, l.to] : []))])
  const near = hover ? touches(hover) : null

  const nodes = layout.nodes.map((n) =>
    n.type === "area" ? { ...n, data: { ...n.data, dim: near ? !near.has(n.id) : false } } : n,
  )
  const edges: Edge[] = visible.map((l) => {
    const a = layout.column.get(l.from) ?? 0
    const b = layout.column.get(l.to) ?? 0
    const [sourceHandle, targetHandle] = a < b ? ["r", "l"] : a > b ? ["lr", "rl"] : ["r", "rl"]
    const active = hover !== null && (l.from === hover || l.to === hover)
    return {
      id: `${l.kind}:${l.from}>${l.to}`,
      source: l.from,
      target: l.to,
      sourceHandle,
      targetHandle,
      type: a === b ? "smoothstep" : "default",
      markerEnd: {
        type: MarkerType.ArrowClosed,
        width: 8,
        height: 8,
        color: active ? "var(--accent)" : "var(--color-line-strong)",
      },
      style: {
        stroke: active ? "var(--accent)" : "var(--color-line-strong)",
        strokeWidth: strokeFor(l.weight),
        strokeDasharray: kindDash[l.kind],
        opacity: hover ? (active ? 1 : 0.06) : a === b ? 0 : 0.55,
      },
    }
  })

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        colorMode="system"
        fitView
        fitViewOptions={{ padding: 0.08 }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => n.type === "area" && navigate(areaPath(n.id))}
        onNodeMouseEnter={(_, n) => n.type === "area" && setHover(n.id)}
        onNodeMouseLeave={() => setHover(null)}
      >
        <Controls showInteractive={false} />
      </ReactFlow>
      <div className="segmented absolute top-0 left-3 items-center gap-0.5 shadow-lg">
        {kinds.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() =>
              setShown((s) => {
                const next = new Set(s)
                if (!next.delete(k)) next.add(k)
                return next
              })
            }
            aria-pressed={shown.has(k)}
            className={clsx(
              "segment h-6 gap-1.5 px-2 text-caption",
              !shown.has(k) && "line-through",
            )}
          >
            <KindSample kind={k} />
            {k}
          </button>
        ))}
        <span className="px-2 text-caption text-muted">
          thickness = weight · same-column links on hover
        </span>
      </div>
      {links.length === 0 ? (
        <div className="absolute inset-x-0 top-14 text-center text-[12px] text-muted">
          No links extracted yet.
        </div>
      ) : null}
      {hover ? (
        <div className="pane floating pointer-events-none absolute bottom-3 left-3 flex items-center gap-1.5 px-2 py-1 text-control">
          <Dot node={atlas.areas.find((a) => a.id === hover)?.node ?? ""} />
          <Token id={hover} />
          <span className="font-mono text-[11px] text-muted">
            {compact(atlas.areas.find((a) => a.id === hover)?.lines ?? 0)} ·{" "}
            {nodeTitle(atlas.areas.find((a) => a.id === hover)?.node ?? "")}
          </span>
        </div>
      ) : null}
    </div>
  )
}
