import { Link, useParams } from "react-router"

import { atlas } from "../atlas-data.ts"
import { Ground, Page } from "../components/ui.tsx"
import { flowPath } from "../links.ts"
import { Sequence } from "./flows/sequence.tsx"
import { Thumb, actorsOf } from "./flows/thumb.tsx"

import "./visual-tokens.css"

export const FlowsPage = () => (
  <Ground
    title="Flows"
    tools={<span className="pane floating px-2 py-1 text-caption text-muted">actors x steps</span>}
  >
    <div className="grid grid-cols-[repeat(auto-fill,minmax(210px,1fr))] gap-3">
      {atlas.flows.map((f) => (
        <Link
          key={f.id}
          to={flowPath(f.id)}
          title={f.summary}
          className="pane group block p-3 text-fg no-underline hover:border-[var(--window-selected-border-color)] hover:text-fg hover:shadow-lg"
        >
          <div className="mb-2 flex h-[150px] items-start overflow-hidden">
            <Thumb flow={f} />
          </div>
          <div className="flex items-baseline justify-between gap-2 border-t border-line pt-2">
            <span className="text-[13px] font-medium group-hover:text-accent">{f.title}</span>
            <span className="shrink-0 font-mono text-[10px] text-muted">
              {actorsOf(f).length}x{f.steps.length}
            </span>
          </div>
        </Link>
      ))}
    </div>
  </Ground>
)

export const FlowPage = () => {
  const { id = "" } = useParams()
  const flow = atlas.flows.find((f) => f.id === id)
  if (!flow) {
    return (
      <Page title="Unknown flow">
        <Link to="/flows">Back to flows</Link>
      </Page>
    )
  }
  return (
    <Ground
      crumbs={
        <>
          <Link to="/flows" className="text-muted no-underline hover:text-fg">
            Flows
          </Link>
          <span>/</span>
        </>
      }
      title={flow.title}
      tools={
        <nav aria-label="Flows" className="segmented gap-0.5 shadow-lg">
          {atlas.flows.map((f) => (
            <Link
              key={f.id}
              to={flowPath(f.id)}
              aria-current={f.id === flow.id ? "page" : undefined}
              className="segment h-7 px-2.5 text-control"
            >
              {f.title}
            </Link>
          ))}
        </nav>
      }
    >
      <Sequence key={flow.id} flow={flow} />
    </Ground>
  )
}
