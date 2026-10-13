import { ArrowUpRight, X } from "lucide-react"
import type { ReactNode } from "react"
import { Link } from "react-router"

import { AnchorIcon, AnchorLink } from "../../components/anchor.tsx"
import type { SqlVerb, Statement, StoreMethod } from "../../lens-runner.ts"
import { procedurePath, tablePath } from "../../links.ts"
import { Tile, VerbGlyph, verbName } from "./glyphs.tsx"
import {
  isTraced,
  lens,
  methodOf,
  namespaces,
  procedureOf,
  reachedBy,
  traceOf,
  verbs,
} from "./model.ts"
import type { Selection } from "./model.ts"
import { Sql } from "./sql.tsx"

type Pick = (s: Selection) => void

const Label = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="mt-5 mb-2 flex items-baseline gap-2">
    <h3 className="section-label m-0">{children}</h3>
    {aside ? <span className="text-caption text-muted">{aside}</span> : null}
  </div>
)

const Verbs = ({ have }: { have: Iterable<SqlVerb> }) => {
  const set = new Set(have)
  return (
    <span className="inline-flex items-center gap-1">
      {verbs
        .filter((v) => set.has(v))
        .map((v) => (
          <VerbGlyph key={v} verb={v} />
        ))}
    </span>
  )
}

const StatementBox = ({ statement }: { statement: Statement }) => (
  <div className="rounded-sm border border-line bg-fill px-2.5 py-2">
    <div className="mb-1 flex items-center gap-2 text-caption text-muted">
      {statement.touches.map((t) => (
        <span key={`${t.table}${t.verb}`} className="flex items-center gap-1 font-mono">
          <VerbGlyph verb={t.verb} size={10} />
          {t.table}
        </span>
      ))}
      <span className="ml-auto">
        <AnchorIcon anchor={statement.anchor} />
      </span>
    </div>
    <div className="max-h-[132px] overflow-auto">
      <Sql sql={statement.sql} />
    </div>
  </div>
)

const MethodButton = ({ method, onPick }: { method: StoreMethod; onPick: Pick }) => (
  <button
    type="button"
    onClick={() => onPick({ kind: "method", id: method.name })}
    className="inline-flex cursor-pointer items-center gap-1.5 rounded-sm border border-line bg-soft px-1.5 py-px font-mono text-control hover:border-line-strong"
  >
    <Verbs have={method.touches.map((t) => t.verb)} />
    {method.name}
  </button>
)

const Heading = ({
  title,
  kind,
  onClose,
  children,
}: {
  title: ReactNode
  kind: string
  onClose: () => void
  children?: ReactNode
}) => (
  <header className="pane-heading flex shrink-0 items-start gap-2 px-4 py-3">
    <div className="min-w-0 flex-1">
      <div className="section-label mb-1">{kind}</div>
      <h2 className="m-0 font-mono text-body font-medium break-words">{title}</h2>
      {children}
    </div>
    <button type="button" className="icon-button" onClick={onClose} aria-label="Clear selection">
      <X size={14} />
    </button>
  </header>
)

const ProcedureDetail = ({ id, onPick }: { id: string; onPick: Pick }) => {
  const procedure = procedureOf.get(id)
  const trace = traceOf.get(id)
  if (!procedure || !trace) return null
  const traced = isTraced(id)
  const reached = reachedBy(id)
  return (
    <>
      <Heading title={id} kind={`${procedure.kind} procedure`} onClose={() => onPick(null)}>
        <div className="mt-2 flex items-center gap-3 text-caption">
          <span className="flex items-center gap-1.5 text-muted">
            <Tile traced={traced} stream={procedure.kind === "stream"} size={12} />
            {traced
              ? `reaches ${reached.length} store ${reached.length === 1 ? "method" : "methods"}`
              : "no store call found"}
          </span>
          <Link
            to={procedurePath(id)}
            className="ml-auto flex items-center gap-0.5 text-muted no-underline hover:text-fg"
          >
            API <ArrowUpRight size={11} />
          </Link>
        </div>
      </Heading>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-5">
        <Label aside="what calls what">Path</Label>
        <ol className="m-0 list-none p-0">
          {trace.steps.map((step, index) => (
            <li
              key={`${step.label}:${step.anchor.line}`}
              className="relative py-[3px]"
              style={{ paddingLeft: step.depth * 14 }}
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-[7px] shrink-0 rounded-full border border-line-strong"
                  style={{ background: index === 0 ? "var(--color-line-strong)" : "transparent" }}
                />
                <span className="min-w-0 truncate font-mono text-control">{step.label}</span>
                <AnchorIcon anchor={step.anchor} />
              </div>
              {step.store.length > 0 ? (
                <div className="mt-1 flex flex-wrap gap-1 pl-[15px]">
                  {step.store.flatMap((name) => {
                    const method = methodOf.get(name)
                    return method
                      ? [<MethodButton key={name} method={method} onPick={onPick} />]
                      : []
                  })}
                </div>
              ) : null}
            </li>
          ))}
        </ol>
        {!traced ? (
          <div className="mt-3 rounded-sm border border-dashed border-line-strong px-3 py-2.5 text-control text-muted">
            <div className="mb-0.5 flex items-center gap-2 font-medium text-fg">
              <span className="size-[9px] rounded-full border-[1.5px] border-dashed border-line-strong" />
              No store call found
            </div>
            The trail ends after {trace.steps.length - 1}{" "}
            {trace.steps.length === 2 ? "step" : "steps"}. It may hold state in memory, or reach the
            store through a call the reader does not follow.
          </div>
        ) : null}
        {reached.map((method) => {
          const from = trace.reached.find((r) => r.method === method.name)?.from
          return (
            <section key={method.name}>
              <Label aside={from ? `via ${from}` : undefined}>
                <button
                  type="button"
                  onClick={() => onPick({ kind: "method", id: method.name })}
                  className="section-label cursor-pointer normal-case tracking-normal hover:text-fg"
                >
                  {method.name}
                </button>
              </Label>
              <div className="flex flex-col gap-1.5">
                {method.statements.map((s) => (
                  <StatementBox key={`${s.anchor.line}`} statement={s} />
                ))}
              </div>
            </section>
          )
        })}
      </div>
    </>
  )
}

const MethodDetail = ({ name, onPick }: { name: string; onPick: Pick }) => {
  const method = methodOf.get(name)
  if (!method) return null
  return (
    <>
      <Heading title={`store.${name}()`} kind="store method" onClose={() => onPick(null)}>
        <div className="mt-2 text-caption">
          <AnchorLink anchor={method.anchor} />
        </div>
      </Heading>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-5">
        <Label aside={`${method.statements.length}`}>SQL</Label>
        <div className="flex flex-col gap-1.5">
          {method.statements.map((s) => (
            <StatementBox key={s.anchor.line} statement={s} />
          ))}
        </div>
        {method.calls.length > 0 ? (
          <>
            <Label>Also calls</Label>
            <div className="flex flex-wrap items-center gap-1">
              {method.calls.map((call) => {
                const other = methodOf.get(call)
                return other ? (
                  <MethodButton key={call} method={other} onPick={onPick} />
                ) : (
                  <span
                    key={call}
                    title="Called here, but not traced into SQL"
                    className="rounded-sm border border-dashed border-line px-1.5 font-mono text-control text-muted"
                  >
                    {call}
                  </span>
                )
              })}
            </div>
          </>
        ) : null}
        <Label aside={`${method.usedBy.length}`}>Reached by</Label>
        {method.usedBy.length === 0 ? (
          <p className="m-0 text-control text-muted">
            No procedure reaches it in the paths the reader follows.
          </p>
        ) : (
          <div className="flex flex-col gap-px">
            {method.usedBy.map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => onPick({ kind: "procedure", id })}
                className="item flex items-center gap-2 px-2 py-[3px] text-left"
              >
                <Tile traced stream={procedureOf.get(id)?.kind === "stream"} size={11} />
                <span className="font-mono text-control">{id}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

const TableDetail = ({ name, onPick }: { name: string; onPick: Pick }) => {
  const touching = lens.methods.filter((m) => m.touches.some((t) => t.table === name))
  const procs = namespaces
    .flatMap(([, list]) => list)
    .filter((p) => reachedBy(p.id).some((m) => m.touches.some((t) => t.table === name)))
  return (
    <>
      <Heading title={name} kind="table" onClose={() => onPick(null)}>
        <div className="mt-2 flex items-center gap-3 text-caption text-muted">
          {procs.length} procedures, {touching.length} store methods
          <Link
            to={tablePath(name)}
            className="ml-auto flex items-center gap-0.5 text-muted no-underline hover:text-fg"
          >
            Data <ArrowUpRight size={11} />
          </Link>
        </div>
      </Heading>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-5">
        <Label aside={`${touching.length}`}>Store methods</Label>
        <div className="flex flex-col gap-px">
          {touching.map((m) => (
            <button
              key={m.name}
              type="button"
              onClick={() => onPick({ kind: "method", id: m.name })}
              className="item flex items-center gap-2 px-2 py-[3px] text-left"
            >
              <Verbs have={m.touches.filter((t) => t.table === name).map((t) => t.verb)} />
              <span className="font-mono text-control">{m.name}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

// What the page says before anything is picked: how to read it, and what it cannot see.
const Overview = ({ hovered }: { hovered: string | null }) => {
  const hover = hovered ? procedureOf.get(hovered) : undefined
  const traced = lens.procedures.filter((p) => p.traced).length
  return (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-4">
      <div className="section-label mb-2">How to read it</div>
      <p className="m-0 mb-3 text-control leading-[18px] text-muted">
        Top, each procedure of the oRPC contract as a tile, by namespace. Below, the store methods
        that run SQL. Columns are tables; pick a tile, a method or a table and the rest lights up.
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0 text-control">
        <li className="flex items-center gap-2.5">
          <Tile traced stream={false} />
          <Tile traced stream />
          <span className="text-muted">call or stream, SQL reached</span>
        </li>
        <li className="flex items-center gap-2.5">
          <Tile traced={false} stream={false} />
          <Tile traced={false} stream />
          <span className="text-muted">no store call found</span>
        </li>
        {verbs.map((verb) => (
          <li key={verb} className="flex items-center gap-2.5">
            <VerbGlyph verb={verb} size={16} />
            <span className="text-muted">
              {verbName[verb]} the table
              {verb === "write" ? " (insert, update, upsert)" : ""}
            </span>
          </li>
        ))}
      </ul>
      <div className="section-label mt-6 mb-2">What it follows</div>
      <p className="m-0 text-control leading-[18px] text-muted">
        Read from the source, not run: the router handler, the service method it calls, and up to
        two calls further, matching store method names. Dynamic calls and callbacks stay invisible,
        so a hollow tile means unknown, not no database.
      </p>
      <div className="mt-6 min-h-[44px] rounded-sm border border-dashed border-line px-3 py-2">
        {hover ? (
          <>
            <div className="font-mono text-control">{hover.id}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-caption text-muted">
              <Tile traced={isTraced(hover.id)} stream={hover.kind === "stream"} size={10} />
              {isTraced(hover.id)
                ? `reaches ${reachedBy(hover.id).length} store methods`
                : "no store call found"}
            </div>
          </>
        ) : (
          <span className="text-caption text-muted">
            {traced} of {lens.procedures.length} procedures traced to SQL. Hover a tile to name it.
          </span>
        )}
      </div>
    </div>
  )
}

export const Detail = ({
  sel,
  hovered,
  onPick,
}: {
  sel: Selection
  hovered: string | null
  onPick: Pick
}) => (
  <aside className="pane floating flex w-[372px] shrink-0 flex-col overflow-hidden">
    {sel?.kind === "procedure" ? (
      <ProcedureDetail id={sel.id} onPick={onPick} />
    ) : sel?.kind === "method" ? (
      <MethodDetail name={sel.id} onPick={onPick} />
    ) : sel?.kind === "table" ? (
      <TableDetail name={sel.id} onPick={onPick} />
    ) : (
      <Overview hovered={hovered} />
    )}
  </aside>
)
