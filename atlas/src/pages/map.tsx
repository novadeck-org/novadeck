import {
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  type Edge,
  type FitViewOptions,
  type Node,
  type NodeProps,
} from "@xyflow/react"
import { clsx } from "clsx"
import { useMemo, useState } from "react"
import { Link, useNavigate, useSearchParams } from "react-router"

import { areaById, atlas, nodeById, nodeTitle } from "../atlas-data.ts"
import type { RuntimeEdge, RuntimeNode } from "../atlas.ts"
import { AnchorIcon } from "../components/anchor.tsx"
import { CanvasBackground, canvasPointer } from "../components/canvas-background.tsx"
import { StackStrip, stackOfNode } from "../components/stack.tsx"
import { squarify } from "../components/treemap.ts"
import { Badge } from "../components/ui.tsx"
import { compact, Dot, hue, Token } from "../components/viz.tsx"
import { areaPath } from "../links.ts"

type NodeData = { node: RuntimeNode; width: number; body: number }
type FlowNode = Node<NodeData, "atlas">

const sides = [
  { position: Position.Top, name: "top" },
  { position: Position.Right, name: "right" },
  { position: Position.Bottom, name: "bottom" },
  { position: Position.Left, name: "left" },
] as const

const HEADER = 26
const linesOf = (node: RuntimeNode) =>
  node.areas.reduce((sum, id) => sum + (areaById.get(id)?.lines ?? 0), 0)
const maxLines = Math.max(1, ...atlas.runtime.nodes.map(linesOf))

// Box size grows with the square root of the node's lines, within fixed bounds.
const sizeOf = (node: RuntimeNode) => {
  const lines = linesOf(node)
  if (lines === 0) return { width: 150, body: 0 }
  const s = Math.sqrt(lines / maxLines)
  return { width: Math.round(150 + 230 * s), body: Math.round(44 + 130 * s) }
}

const AtlasNode = ({ data, selected }: NodeProps<FlowNode>) => {
  const { node, width, body } = data
  const navigate = useNavigate()
  const [hover, setHover] = useState<string | null>(null)
  const lines = linesOf(node)
  const hovered = hover ? areaById.get(hover) : undefined
  const blocks = useMemo(
    () =>
      squarify(
        node.areas.flatMap((id) => {
          const area = areaById.get(id)
          return area ? [{ item: area, value: area.lines }] : []
        }),
        0,
        0,
        width - 8,
        body - 8,
      ),
    [node, width, body],
  )
  return (
    <div
      style={{ width }}
      className={clsx(
        "pane",
        node.kind === "external" && "border-dashed border-[var(--color-line-strong)]",
        selected && "selected",
      )}
    >
      <div
        className={clsx(
          "pane-heading mb-1 flex items-center gap-1.5 px-2 text-[12px] font-medium",
          !selected && "quiet",
          body === 0 && "border-b-0",
        )}
        style={{ height: HEADER }}
      >
        <Dot node={node.id} />
        <span className={clsx("truncate", hovered && "font-mono")}>
          {hovered ? hovered.id : node.title}
        </span>
        <span className="ml-auto font-mono text-[11px] font-normal text-muted">
          {compact(hovered ? hovered.lines : lines)}
        </span>
      </div>
      {body > 0 ? (
        <div className="relative mx-1 mb-1" style={{ height: body - 8 }}>
          {blocks.map(({ item, x, y, w, h }) => (
            <button
              key={item.id}
              type="button"
              onMouseEnter={() => setHover(item.id)}
              onMouseLeave={() => setHover(null)}
              onClick={(event) => {
                event.stopPropagation()
                navigate(areaPath(item.id))
              }}
              className={clsx(
                "nodrag nopan absolute cursor-pointer overflow-hidden border text-left text-[10px] leading-3",
                hover === item.id
                  ? "z-10 border-accent text-[var(--color-paper)]"
                  : "border-[var(--color-paper)]",
                hover && hover !== item.id && "opacity-50",
              )}
              style={{
                left: x,
                top: y,
                width: w,
                height: h,
                background: hover === item.id ? "var(--accent)" : hue(node.id).fill,
              }}
            >
              {w > 52 && h > 16 ? (
                <span className="block truncate px-1 pt-0.5 font-mono">{item.id}</span>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      {sides.map((s) => (
        <span key={s.name}>
          <Handle id={`in-${s.name}`} type="target" position={s.position} className="!opacity-0" />
          <Handle id={`out-${s.name}`} type="source" position={s.position} className="!opacity-0" />
        </span>
      ))}
    </div>
  )
}

const nodeTypes = { atlas: AtlasNode }

const sideFor = (from: RuntimeNode, to: RuntimeNode) => {
  const dx = to.position.x - from.position.x
  const dy = to.position.y - from.position.y
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? ["right", "left"] : ["left", "right"]
  return dy >= 0 ? ["bottom", "top"] : ["top", "bottom"]
}

// "Utility process + MessagePort" -> "MessagePort"; "PTY (node-pty)" -> "PTY".
const shortChannel = (channel: string) =>
  channel
    .replace(/\s*\(.*\)/, "")
    .replace(/^.*\+\s*/, "")
    .replace(/ over .*$/, "")

type Selection = { type: "node" | "edge"; id: string } | null

const Eyebrow = ({ children }: { children: string }) => (
  <div className="section-label">{children}</div>
)

const NodePanel = ({ node }: { node: RuntimeNode }) => {
  return (
    <>
      <Eyebrow>{node.kind}</Eyebrow>
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{node.title}</h2>
        <AnchorIcon anchor={node.anchor} />
      </div>
      <p className="mt-1 line-clamp-2 text-[12px] text-muted">{node.summary}</p>
      {stackOfNode(node.id) ? (
        <div className="mt-3">
          <StackStrip token={stackOfNode(node.id)!} max={2} fit />
        </div>
      ) : null}
      {node.areas.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-1">
          {node.areas.map((id) => (
            <Link
              key={id}
              to={areaPath(id)}
              className="inline-flex items-center gap-1 rounded-sm border border-line px-1.5 text-[11px] leading-5 text-fg no-underline hover:border-accent"
              title={`${areaById.get(id)?.purpose ?? ""} (${areaById.get(id)?.lines ?? 0} lines)`}
            >
              <Dot node={node.id} size={6} />
              <Token id={id} />
            </Link>
          ))}
        </div>
      ) : null}
    </>
  )
}

const EdgePanel = ({ edge }: { edge: RuntimeEdge }) => (
  <>
    <Eyebrow>edge</Eyebrow>
    <div className="flex items-center gap-2">
      <h2 className="text-base font-semibold">
        {nodeTitle(edge.from)} {"->"} {nodeTitle(edge.to)}
      </h2>
      <AnchorIcon anchor={edge.anchor} />
    </div>
    <div className="mt-1">
      <Badge accent>{edge.channel}</Badge>
    </div>
    <p className="mt-2 line-clamp-3 text-[12px] text-muted">{edge.summary}</p>
  </>
)

// Edges between the same two nodes draw as one line, labelled with every channel.
const parallel = atlas.runtime.edges.reduce<[RuntimeEdge, ...RuntimeEdge[]][]>((groups, edge) => {
  const group = groups.find(([first]) => first.from === edge.from && first.to === edge.to)
  return group
    ? groups.map((each) => (each === group ? [...each, edge] : each))
    : [...groups, [edge]]
}, [])

// Room on the right for the selection panel, so it never covers a node: on the first fit
// and on the fit button alike.
const fit: FitViewOptions = {
  padding: { top: "48px", left: "48px", bottom: "48px", right: "336px" },
}

export const MapPage = () => {
  // The selection lives in the URL (`?node=` or `?edge=`), so links, search and the back
  // button all agree with what is drawn.
  const [params, setParams] = useSearchParams()
  const nodeParam = params.get("node")
  const edgeParam = params.get("edge")
  const selection = useMemo<Selection>(
    () =>
      edgeParam
        ? { type: "edge", id: edgeParam }
        : nodeParam
          ? { type: "node", id: nodeParam }
          : null,
    [edgeParam, nodeParam],
  )
  const setSelection = (next: Selection) =>
    setParams(next ? { [next.type]: next.id } : {}, { replace: true })

  const nodes = useMemo<FlowNode[]>(
    () =>
      atlas.runtime.nodes.map((node) => ({
        id: node.id,
        type: "atlas",
        position: { x: node.position.x * 1.25, y: node.position.y * 1.15 },
        data: { node, ...sizeOf(node) },
        selected: selection?.type === "node" && selection.id === node.id,
      })),
    [selection],
  )
  const edges = useMemo<Edge[]>(
    () =>
      parallel.map(([edge, ...more]) => {
        const from = nodeById.get(edge.from)
        const to = nodeById.get(edge.to)
        const [a, b] = from && to ? sideFor(from, to) : ["right", "left"]
        const selected =
          selection?.type === "edge" && [edge, ...more].some((each) => each.id === selection.id)
        return {
          id: edge.id,
          source: edge.from,
          target: edge.to,
          sourceHandle: `out-${a}`,
          targetHandle: `in-${b}`,
          label: [edge, ...more].map((each) => shortChannel(each.channel)).join(" · "),
          selected,
          markerEnd: {
            type: MarkerType.ArrowClosed,
            color: selected ? "var(--accent)" : "var(--color-line-strong)",
          },
          style: selected
            ? { stroke: "var(--accent)", strokeWidth: 2 }
            : { stroke: "var(--color-line-strong)" },
          labelStyle: { fill: "var(--fg)", fontSize: 10, fontFamily: "var(--font-mono)" },
          labelBgStyle: { fill: "var(--panel)", stroke: "var(--line)" },
          labelBgPadding: [4, 2],
        }
      }),
    [selection],
  )

  const node = selection?.type === "node" ? nodeById.get(selection.id) : undefined
  const edge =
    selection?.type === "edge" ? atlas.runtime.edges.find((e) => e.id === selection.id) : undefined

  return (
    <div className="relative min-w-0 flex-1">
      <div className="workspace absolute inset-0" {...canvasPointer}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          colorMode="system"
          fitView
          fitViewOptions={fit}
          // Low enough that the reserved room still leaves the whole map in a small window.
          minZoom={0.2}
          nodesDraggable={false}
          nodesConnectable={false}
          proOptions={{ hideAttribution: true }}
          onNodeClick={(_, n) => setSelection({ type: "node", id: n.id })}
          onEdgeClick={(_, e) => {
            const group = parallel.find(([first]) => first.id === e.id)
            setSelection({ type: "edge", id: group?.[0].id ?? e.id })
          }}
          onPaneClick={() => setSelection(null)}
        >
          <CanvasBackground />
          <Controls showInteractive={false} fitViewOptions={fit} />
        </ReactFlow>
      </div>
      {node || edge ? (
        <aside className="pane floating absolute top-3 right-3 w-72 p-3">
          {node ? <NodePanel node={node} /> : null}
          {edge ? <EdgePanel edge={edge} /> : null}
        </aside>
      ) : null}
    </div>
  )
}
