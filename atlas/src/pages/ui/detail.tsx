import { ArrowUpRight } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router"

import type { Anchor } from "../../atlas.ts"
import { AnchorIcon, AnchorLink } from "../../components/anchor.tsx"
import { Token } from "../../components/viz.tsx"
import type { Effect, UiAction } from "../../lens-ui.ts"
import { areaPath, procedurePath } from "../../links.ts"
import {
  actionBy,
  boxBy,
  lens,
  procedureBy,
  type Selection,
  streamBy,
  untracedStreams,
} from "./model.ts"

const Chip = ({ id }: { id: string }) => (
  <Link
    to={areaPath(id)}
    className="inline-flex items-center gap-1 whitespace-nowrap rounded-sm border border-line px-1.5 text-caption leading-5 text-fg no-underline hover:border-accent"
  >
    <Token id={id} />
  </Link>
)

const Step = ({ hue, title, children }: { hue: string; title: string; children: ReactNode }) => (
  <div className="up-step" style={{ ["--_hue" as string]: `var(${hue})` }}>
    <span className="up-mark" />
    <div className="section-label mb-1.5">{title}</div>
    <div className="space-y-1.5 text-control">{children}</div>
  </div>
)

const Gap = ({ children }: { children: ReactNode }) => <p className="up-gap m-0">{children}</p>

const where = (anchor: Anchor | null) => (anchor ? <AnchorLink anchor={anchor} /> : null)

// A procedure the page lists: pick it here, and jump to the API tab beside it.
export const ProcChip = ({ id, onPick }: { id: string; onPick: (id: string) => void }) => (
  <span className="inline-flex items-center overflow-hidden rounded-sm border border-line">
    <button
      type="button"
      onClick={() => onPick(id)}
      className="cursor-pointer px-1.5 font-mono text-control leading-5 hover:bg-soft"
    >
      {id}
    </button>
    <Link
      to={procedurePath(id)}
      title="Open in the API tab"
      className="inline-flex items-center border-l border-line px-1 text-muted hover:text-accent"
    >
      <ArrowUpRight size={12} />
    </Link>
  </span>
)

const EffectRow = ({ effect, onPick }: { effect: Effect; onPick: (id: string) => void }) => (
  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
    <span
      className="badge px-1.5 text-label leading-4"
      title={
        effect.basis === "action"
          ? "The adapter tests this action's type."
          : "The adapter compares the workspace before and after; the link to this action comes from what its reducer case does."
      }
    >
      {effect.basis === "action" ? "tests action" : `inferred: ${effect.trigger}`}
    </span>
    {effect.procedures.map((id) => (
      <ProcChip key={id} id={id} onPick={onPick} />
    ))}
    <span className="min-w-0 truncate font-mono text-caption text-muted" title={effect.via}>
      {effect.via}
    </span>
    <span className="ml-auto">
      <AnchorIcon anchor={effect.anchor} />
    </span>
  </div>
)

const portCommit = boxBy.get("port")?.items.find((item) => item.label === "commit")?.anchor ?? null

const ActionPath = ({ action, onPick }: { action: UiAction; onPick: (id: string) => void }) => (
  <div>
    <Step hue="--g-ui" title="Dispatched by">
      {action.fromUi.map((site) => (
        <div
          key={`${site.anchor.file}:${site.anchor.line}`}
          className="flex flex-wrap items-center gap-x-2 gap-y-1"
        >
          <Chip id={site.area} />
          {site.fn ? (
            <span className="font-mono">{site.fn}()</span>
          ) : (
            <span className="text-muted">anonymous</span>
          )}
          {site.callers ? (
            <span className="text-caption text-muted">
              {site.callers.files === 0
                ? "no caller found"
                : `${site.callers.files} caller file${site.callers.files === 1 ? "" : "s"} in ${site.callers.areas.length} area${site.callers.areas.length === 1 ? "" : "s"}`}
            </span>
          ) : (
            <span className="text-caption text-warning-fg">callers not traced</span>
          )}
          <span className="ml-auto">
            <AnchorIcon anchor={site.anchor} />
          </span>
        </div>
      ))}
      {action.fromUi.length === 0 && action.fromAdapter.length > 0 ? (
        <p className="m-0 text-muted">
          Not built by the UI: only the runner adapter dispatches it.
        </p>
      ) : null}
      {action.untraced ? <Gap>{action.untraced}</Gap> : null}
    </Step>
    <Step hue="--g-ui" title="Reducer, then the commit hook">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5">
          <span className="font-mono">workspaceReducer</span>
          {where(action.reducer)}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="font-mono">Backend.commit</span>
          {where(portCommit)}
        </span>
      </div>
    </Step>
    <Step hue="--g-runner" title="Runner adapter">
      {action.effects.map((effect) => (
        <EffectRow
          key={`${effect.procedures[0]}:${effect.trigger}:${effect.anchor.line}`}
          effect={effect}
          onPick={onPick}
        />
      ))}
      {action.effects.length === 0 ? (
        <Gap>No adapter code tests or reacts to this action: it only rides the save below.</Gap>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-muted">
        every commit, any action:
        {lens.everyCommit.map((effect) => (
          <span key={effect.via} className="inline-flex items-center gap-1.5">
            {effect.procedures.map((id) => (
              <ProcChip key={id} id={id} onPick={onPick} />
            ))}
          </span>
        ))}
      </div>
    </Step>
    <Step hue="--h-codex" title="Comes back">
      {action.returns.map((id) => {
        const stream = streamBy.get(id)
        return (
          <div key={id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <ProcChip id={id} onPick={onPick} />
            <span className="text-caption text-muted">its handler dispatches this</span>
            {stream?.handler ? (
              <span className="ml-auto">
                <AnchorIcon anchor={stream.handler} />
              </span>
            ) : null}
          </div>
        )
      })}
      {action.fromAdapter.map((site) => (
        <div
          key={`${site.anchor.file}:${site.anchor.line}`}
          className="flex items-center gap-2 text-caption text-muted"
        >
          adapter dispatch in <span className="font-mono text-fg">{site.fn ?? "?"}()</span>
          <span className="ml-auto">
            <AnchorIcon anchor={site.anchor} />
          </span>
        </div>
      ))}
      {action.fromAdapter.length > 0 && action.returns.length === 0 ? (
        <Gap>The adapter dispatches this, but no stream handler was traced to the site.</Gap>
      ) : null}
      {action.fromAdapter.length === 0 ? (
        <p className="m-0 text-muted">Nothing from the runner dispatches it.</p>
      ) : null}
    </Step>
  </div>
)

const ProcedureDetail = ({
  id,
  onPick,
  onAction,
}: {
  id: string
  onPick: (id: string) => void
  onAction: (type: string) => void
}) => {
  const procedure = procedureBy.get(id)
  const stream = streamBy.get(id)
  if (!procedure) return null
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <ProcChip id={id} onPick={onPick} />
        <span className="badge px-1.5 text-label leading-4">{procedure.kind}</span>
      </div>
      <Step hue="--g-ui" title="Called from the adapter">
        {procedure.sites.map((site) => (
          <div key={`${site.file}:${site.line}`}>
            <AnchorLink anchor={site} />
          </div>
        ))}
      </Step>
      {procedure.kind === "call" ? (
        <Step hue="--g-runner" title="Reached by">
          {procedure.actions.length ? (
            <div className="flex flex-wrap gap-1.5">
              {procedure.actions.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => onAction(type)}
                  className="cursor-pointer rounded-sm border border-line px-1.5 font-mono text-control leading-5 hover:bg-soft"
                >
                  {type}
                </button>
              ))}
            </div>
          ) : procedure.fromCommit ? (
            <p className="m-0 text-muted">
              Every commit, whatever the action (see the runner adapter step).
            </p>
          ) : (
            <Gap>
              Not reached from a commit: called at boot, from a port method, or from a reply. The
              scan does not trace those further.
            </Gap>
          )}
        </Step>
      ) : (
        <Step hue="--h-codex" title="Handled by">
          {stream?.handler ? (
            <div>
              <AnchorLink anchor={stream.handler} />
            </div>
          ) : (
            <Gap>No handler found: the stream is consumed somewhere the scan does not follow.</Gap>
          )}
          {stream?.dispatches.length ? (
            <div className="flex flex-wrap gap-1.5">
              {stream.dispatches.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => onAction(type)}
                  className="cursor-pointer rounded-sm border border-line px-1.5 font-mono text-control leading-5 hover:bg-soft"
                >
                  {type}
                </button>
              ))}
            </div>
          ) : stream?.feeds ? (
            <p className="m-0 text-muted">
              Feeds <span className="font-mono text-fg">{stream.feeds}</span>, not workspace
              actions.
            </p>
          ) : (
            <Gap>No write to a store was found in the handler.</Gap>
          )}
        </Step>
      )}
    </div>
  )
}

const BoxDetail = ({ id }: { id: string }) => {
  const box = boxBy.get(id as never)
  if (!box) return null
  return (
    <div>
      <div className="mb-2 flex items-baseline gap-2">
        <span className="font-mono text-title font-medium">{box.count}</span>
        <span className="text-control text-muted">{box.unit}</span>
      </div>
      {id === "streams" && untracedStreams().length ? (
        <Gap>
          {untracedStreams()
            .map((stream) => stream.procedure)
            .join(", ")}
          : no write to a store found.
        </Gap>
      ) : null}
      <ul className="m-0 mt-2 list-none space-y-0.5 p-0">
        {box.items.map((item) => (
          <li
            key={`${item.label}:${item.anchor?.line}`}
            className="flex items-center gap-2 border-b border-line/60 py-1 text-control"
          >
            <span className="min-w-0 truncate font-mono">{item.label}</span>
            {item.note ? (
              <span className="shrink-0 text-caption text-muted">{item.note}</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-2">
              {item.area ? <Chip id={item.area} /> : null}
              {item.anchor ? <AnchorIcon anchor={item.anchor} /> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export const detailTitle = (selection: Selection): string => {
  if (!selection) return "Path"
  if (selection.kind === "box") return boxBy.get(selection.id as never)?.title ?? "Path"
  return selection.id
}

export const Detail = ({
  selection,
  onSelect,
}: {
  selection: Selection
  onSelect: (selection: Selection) => void
}) => {
  const pickProcedure = (id: string) => onSelect({ kind: "procedure", id })
  const pickAction = (type: string) => onSelect({ kind: "action", id: type })
  if (!selection) {
    return (
      <p className="m-0 p-1 text-control text-muted">
        Pick an action, a call or a box. Its path lights up above.
      </p>
    )
  }
  if (selection.kind === "box") return <BoxDetail id={selection.id} />
  if (selection.kind === "procedure")
    return <ProcedureDetail id={selection.id} onPick={pickProcedure} onAction={pickAction} />
  const action = actionBy.get(selection.id)
  return action ? <ActionPath action={action} onPick={pickProcedure} /> : null
}
