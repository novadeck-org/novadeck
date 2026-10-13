import { Blocks, Network } from "lucide-react"
import { FileText } from "lucide-react"
import { useState } from "react"
import { Link, useParams, useSearchParams } from "react-router"

import { areaById, atlas, nodeTitle } from "../atlas-data.ts"
import type { Area } from "../atlas.ts"
import { AnchorIcon, blobUrl } from "../components/anchor.tsx"
import { StackStrip } from "../components/stack.tsx"
import { Empty, Ground, Page } from "../components/ui.tsx"
import { compact, Dot, hue, KindSample, links, Segmented } from "../components/viz.tsx"
import { areaPath, nodePath, procedurePath, tablePath, toolPath } from "../links.ts"
import { EgoGraph } from "./areas/ego.tsx"
import { GraphView } from "./areas/graph-view.tsx"
import { TreemapView } from "./areas/treemap-view.tsx"

type View = "treemap" | "graph"

export const AreasPage = () => {
  const [params, setParams] = useSearchParams()
  // Where the treemap docks its "too small to draw" control, among the header tools.
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const view: View = params.get("view") === "graph" ? "graph" : "treemap"
  if (atlas.areas.length === 0) {
    return (
      <Page title="Areas">
        <Empty>No areas extracted yet.</Empty>
      </Page>
    )
  }
  return (
    <Ground
      title="Areas"
      flush
      tools={
        <>
          <span ref={setSlot} />
          {view === "treemap" ? (
            <span className="pane floating flex h-9 items-center gap-2 px-3 text-caption text-muted">
              area = lines
              <span className="hatch inline-block h-3 w-5 border border-line" /> tests
            </span>
          ) : null}
          <Segmented
            floating
            value={view}
            onChange={(v) => setParams(v === "graph" ? { view: "graph" } : {})}
            options={[
              { id: "treemap", label: "Size", icon: <Blocks size={13} /> },
              { id: "graph", label: "Links", icon: <Network size={13} /> },
            ]}
          />
        </>
      }
    >
      <div className={view === "treemap" ? "min-h-0 flex-1 px-1.5 pb-1.5" : "min-h-0 flex-1"}>
        {view === "treemap" ? <TreemapView slot={slot} /> : <GraphView />}
      </div>
    </Ground>
  )
}

// A token with each part that is an area of its own linking to it: `ui` / `backend` /
// `runner`.
const TokenPath = ({ id }: { id: string }) => {
  const parts = id.split("/")
  return (
    <span className="font-mono">
      {parts.map((part, i) => {
        const upTo = parts.slice(0, i + 1).join("/")
        const last = i === parts.length - 1
        return (
          <span key={upTo}>
            {i > 0 ? <span className="text-muted">/</span> : null}
            {!last && areaById.has(upTo) ? (
              <Link to={areaPath(upTo)} className="text-muted no-underline hover:text-fg">
                {part}
              </Link>
            ) : (
              <span className={last ? "" : "text-muted"}>{part}</span>
            )}
          </span>
        )
      })}
    </span>
  )
}

const Owned = ({
  label,
  ids,
  to,
}: {
  label: string
  ids: string[]
  to: (id: string) => string
}) => {
  const [open, setOpen] = useState(false)
  if (ids.length === 0) return null
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="pane cursor-pointer px-2 py-0.5 text-[12px] hover:border-accent"
        aria-expanded={open}
      >
        <span className="font-mono font-semibold">{ids.length}</span>{" "}
        <span className="text-muted">{label}</span>
      </button>
      {open ? (
        <div className="mt-2 flex max-w-2xl flex-wrap gap-1">
          {ids.map((id) => (
            <Link
              key={id}
              to={to(id)}
              className="rounded-sm border border-[var(--window-border-color)] bg-panel px-1.5 font-mono text-[11px] leading-5 no-underline"
            >
              {id}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export const AreaPage = () => {
  const id = useParams()["*"] ?? ""
  const area = areaById.get(id)
  if (!area) {
    return (
      <Page title="Unknown area">
        <Link to="/areas">Back to areas</Link>
      </Page>
    )
  }
  return <AreaBody key={area.id} area={area} />
}

// Keyed by area, so what the reader opened on one area never carries over to the next.
const AreaBody = ({ area }: { area: Area }) => {
  const linked = links.some((l) => l.from !== l.to && (l.from === area.id || l.to === area.id))
  const maxLines = Math.max(...atlas.areas.map((a) => a.lines))
  const share = area.files > 0 ? Math.min(1, area.tests / area.files) : 0
  return (
    <Ground
      crumbs={
        <>
          <Link to="/areas" className="text-muted no-underline hover:text-fg">
            Areas
          </Link>
          <span>/</span>
        </>
      }
      title={<TokenPath id={area.id} />}
      tools={
        <span className="flex items-center gap-3">
          <StackStrip token={area.id} max={4} />
          <span className="pane floating flex h-9 items-center gap-1 px-2">
            <Link
              to={nodePath(area.node)}
              title="Runs in"
              className="mr-2 flex items-center gap-1.5 text-control text-muted no-underline hover:text-fg"
            >
              <Dot node={area.node} />
              {nodeTitle(area.node)}
            </Link>
            {area.entries.map((e) => (
              <AnchorIcon key={`${e.file}:${e.line}`} anchor={e} size={15} />
            ))}
            {area.docs.map((d) => (
              <a
                key={d}
                href={blobUrl(d)}
                target="_blank"
                rel="noreferrer"
                title={d}
                className="icon-button small"
              >
                <FileText size={13} />
              </a>
            ))}
          </span>
        </span>
      }
    >
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="pane p-4">
          <div className="flex items-center gap-3">
            <div
              className="relative h-3 overflow-hidden rounded-sm bg-raised"
              style={{ width: "min(100%, 28rem)" }}
              title={`${area.lines.toLocaleString()} lines, ${area.files} files, ${area.tests} test files`}
            >
              <div
                className="absolute inset-y-0 left-0"
                style={{
                  width: `${(area.lines / maxLines) * 100}%`,
                  background: hue(area.node).ink,
                }}
              >
                <div
                  className="hatch absolute inset-y-0 right-0"
                  style={{ width: `${share * 100}%` }}
                />
              </div>
            </div>
            <span className="font-mono text-[12px]">{compact(area.lines)}</span>
            <span className="font-mono text-[11px] text-muted">
              {area.files} files · {area.tests} tests
            </span>
          </div>
          {area.purpose ? (
            <p className="mt-3 max-w-2xl text-[12px] text-muted">{area.purpose}</p>
          ) : null}
        </header>
        {linked ? (
          <section className="space-y-2">
            <div className="flex flex-wrap items-center gap-4 text-[11px] text-muted">
              <span>depends on</span>
              <span className="flex items-center gap-1">
                <KindSample kind="import" /> import
              </span>
              <span className="flex items-center gap-1">
                <KindSample kind="call" /> call
              </span>
              <span className="flex items-center gap-1">
                <KindSample kind="data" /> data
              </span>
              <span className="ml-auto">used by</span>
            </div>
            <EgoGraph id={area.id} />
          </section>
        ) : (
          <p className="text-[12px] text-muted">
            No links found by the scan. That is not proof there are none: it reads imports, calls
            and data access in the source it follows.
          </p>
        )}
        <section className="flex flex-wrap items-start gap-2">
          <Owned label="procedures" ids={area.procedures} to={procedurePath} />
          <Owned label="tables" ids={area.tables} to={tablePath} />
          <Owned label="tools" ids={area.tools} to={toolPath} />
        </section>
      </div>
    </Ground>
  )
}
