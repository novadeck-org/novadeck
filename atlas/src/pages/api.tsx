import { ChevronDown, ChevronRight, Search } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useLocation, useNavigate } from "react-router"

import { areaById, atlas, groupBy, procedureById } from "../atlas-data.ts"
import type { Procedure } from "../atlas.ts"
import { AnchorLink } from "../components/anchor.tsx"
import { Ground } from "../components/ui.tsx"
import { hashId } from "../links.ts"
import { CodePane } from "./api/code.tsx"
import { isEmpty } from "./api/model.ts"
import { ParamsTable } from "./api/params.tsx"
import { AreaChip } from "./api/shared.tsx"

const KindBadge = ({ kind, large = false }: { kind: Procedure["kind"]; large?: boolean }) => (
  <span
    className={`inline-flex shrink-0 items-center justify-center rounded-sm font-mono font-semibold uppercase tracking-wide ${
      large ? "h-5 px-2 text-[10.5px]" : "h-4 w-[44px] text-[9px]"
    } ${
      kind === "call"
        ? "border border-[var(--color-line-strong)] text-muted"
        : "border border-transparent bg-[var(--color-line-strong)] text-[var(--color-paper)]"
    }`}
  >
    {kind}
  </span>
)

const NavRow = ({
  p,
  selected,
  onSelect,
}: {
  p: Procedure
  selected: boolean
  onSelect: (id: string) => void
}) => {
  const ref = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (selected) ref.current?.scrollIntoView({ block: "nearest" })
  }, [selected])
  return (
    <button
      ref={ref}
      type="button"
      onClick={() => onSelect(p.id)}
      data-selected={selected}
      className="item flex w-full items-center gap-2 py-[5px] pl-3 pr-2 text-left"
    >
      <KindBadge kind={p.kind} />
      <span className="min-w-0 truncate font-mono text-[12.5px]">{p.name}</span>
    </button>
  )
}

const ErrorCodes = () => {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-t border-[var(--region-sidebar-border-color)] px-3">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="section-label flex h-[38px] w-full cursor-pointer items-center gap-1.5 px-0.5 text-left hover:text-fg"
      >
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        All error codes
        <span className="count ml-auto">{atlas.api.errors.length}</span>
      </button>
      {open ? (
        <ul className="pb-2">
          {atlas.api.errors.map((e) => (
            <li
              key={e.code}
              title={e.note ?? undefined}
              className="flex items-baseline justify-between gap-2 px-0.5 py-0.5 font-mono text-caption"
            >
              <span className="truncate">{e.code}</span>
              <span className="text-muted">{e.status}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

const Nav = ({
  selected,
  onSelect,
}: {
  selected: string | null
  onSelect: (id: string) => void
}) => {
  const [filter, setFilter] = useState("")
  const [closed, setClosed] = useState<Set<string>>(new Set())
  const terms = filter.toLowerCase().split(/\s+/).filter(Boolean)
  const searching = terms.length > 0
  const groups = useMemo(() => {
    const matches = (p: Procedure) => {
      const hay =
        `${p.id} ${p.namespace} ${p.area ?? ""} ${areaById.get(p.area ?? "")?.purpose ?? ""}`.toLowerCase()
      return terms.every((t) => hay.includes(t))
    }
    return groupBy(atlas.api.procedures, (p) => p.namespace)
      .map(([ns, list]): [string, Procedure[]] => [ns, list.filter(matches)])
      .filter(([, list]) => list.length)
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [filter])
  return (
    <nav className="sidebar flex w-64 shrink-0 flex-col">
      <div className="px-3 pt-3 pb-1">
        <label className="relative block">
          <Search size={13} className="absolute left-2 top-1/2 -translate-y-1/2 text-muted" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Search procedures"
            className="field h-8 w-full pl-7 pr-2 text-control"
          />
        </label>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 pb-2">
        {groups.map(([ns, list]) => {
          const open = searching || !closed.has(ns)
          return (
            <div key={ns}>
              <button
                type="button"
                onClick={() =>
                  setClosed((prev) => {
                    const next = new Set(prev)
                    if (!next.delete(ns)) next.add(ns)
                    return next
                  })
                }
                className="section-label flex h-[34px] w-full cursor-pointer items-center gap-1 px-0.5 text-left hover:text-fg"
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {ns}
                <span className="count ml-auto">{list.length}</span>
              </button>
              {open
                ? list.map((p) => (
                    <NavRow key={p.id} p={p} selected={p.id === selected} onSelect={onSelect} />
                  ))
                : null}
            </div>
          )
        })}
        {groups.length === 0 ? (
          <div className="px-3 py-4 text-[12px] text-muted">No matches</div>
        ) : null}
      </div>
      <ErrorCodes />
    </nav>
  )
}

const Section = ({
  title,
  hint,
  children,
}: {
  title: string
  hint?: ReactNode
  children: ReactNode
}) => (
  <section className="mt-7">
    <div className="mb-2.5 flex items-baseline gap-3">
      <h2 className="section-label m-0">{title}</h2>
      {hint ? <span className="text-caption text-muted">{hint}</span> : null}
    </div>
    {children}
  </section>
)

const None = ({ children }: { children: ReactNode }) => (
  <div className="rounded-sm border border-dashed border-[var(--color-outline)] px-3 py-2 text-[12.5px] text-muted">
    {children}
  </div>
)

// Codes every procedure behind the router's middleware can get, found as the ones most
// procedures list.
const routerCodes = new Set(
  (() => {
    const counts = new Map<string, number>()
    for (const p of atlas.api.procedures)
      for (const code of p.errors) counts.set(code, (counts.get(code) ?? 0) + 1)
    return [...counts].filter(([, n]) => n >= atlas.api.procedures.length / 2).map(([c]) => c)
  })(),
)

const Errors = ({ p }: { p: Procedure }) => {
  const codes = atlas.api.errors.filter((e) => p.errors.includes(e.code))
  return (
    <Section
      title="Errors"
      hint="Raised in the handler and by the router; helpers deeper down may raise others."
    >
      {codes.length === 0 ? (
        <None>No error codes found.</None>
      ) : (
        <div className="overflow-hidden rounded-sm border border-[var(--color-outline)] bg-panel">
          <div className="grid grid-cols-[minmax(0,2.2fr)_48px_60px_minmax(0,1.6fr)] gap-x-3 bg-raised px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted">
            <span>Code</span>
            <span>Status</span>
            <span>From</span>
            <span>Note</span>
          </div>
          {codes.map((e) => (
            <div
              key={e.code}
              className="grid grid-cols-[minmax(0,2.2fr)_48px_60px_minmax(0,1.6fr)] items-baseline gap-x-3 border-t border-line px-3 py-2"
            >
              <span className="break-all font-mono text-[12.5px] font-medium">{e.code}</span>
              <span className="font-mono text-[12px]">{e.status}</span>
              <span className="font-mono text-[10.5px] text-muted">
                {routerCodes.has(e.code) ? "router" : "handler"}
              </span>
              <span className="text-[12px] leading-[18px] text-muted">{e.note ?? "—"}</span>
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const Reference = ({ p }: { p: Procedure }) => {
  const input = isEmpty(p.input) ? null : p.input
  const output = isEmpty(p.output) ? null : p.output
  const stream = p.kind === "stream"
  return (
    <div className="mx-auto max-w-[760px] px-3 pb-16 pt-2">
      <header>
        <p className="m-0 text-[12.5px] text-muted">
          {stream
            ? "oRPC stream on the runner: one request opens it, then the runner yields events over the authenticated runner connection."
            : "oRPC procedure on the runner, called over the authenticated runner connection."}
        </p>
      </header>

      <Section title="Request" hint={`${p.id} input`}>
        {input ? <ParamsTable schema={input} /> : <None>No input.</None>}
      </Section>

      <Section
        title={stream ? "Events" : "Response"}
        hint={stream ? "Yields a sequence of the event schema below." : undefined}
      >
        {output ? (
          <ParamsTable schema={output} />
        ) : (
          <None>{stream ? "No event payload." : "No output (void)."}</None>
        )}
      </Section>

      <Errors p={p} />

      <Section title="Implementation">
        <dl className="grid grid-cols-[84px_minmax(0,1fr)] gap-x-3 gap-y-2 text-[12.5px]">
          <dt className="text-muted">Contract</dt>
          <dd>
            <AnchorLink anchor={p.anchor} />
          </dd>
          <dt className="text-muted">Handler</dt>
          <dd>
            {p.handler ? (
              <AnchorLink anchor={p.handler} />
            ) : (
              <span className="text-muted">none</span>
            )}
          </dd>
          <dt className="text-muted">Callers {p.callers.length}</dt>
          <dd className="flex flex-col gap-1">
            {p.callers.map((c) => (
              <AnchorLink key={`${c.file}:${c.line}`} anchor={c} />
            ))}
            {p.callers.length === 0 ? <span className="text-muted">none</span> : null}
          </dd>
        </dl>
      </Section>
    </div>
  )
}

export const ApiPage = () => {
  const { hash } = useLocation()
  const navigate = useNavigate()
  const wanted = hashId(hash)
  // No hash opens the first procedure; a hash that names none says so rather than showing another.
  const p = wanted ? procedureById.get(wanted) : atlas.api.procedures[0]
  if (!p) {
    if (atlas.api.procedures.length === 0)
      return <div className="p-6 text-muted">No procedures.</div>
    return (
      <Ground
        title={<span className="font-mono">No procedure {wanted}</span>}
        side={
          <Nav selected={null} onSelect={(id) => void navigate({ hash: id }, { replace: true })} />
        }
        flush
      >
        <p className="px-3 text-muted">
          Nothing in the API is called {wanted}. Pick a procedure from the list.
        </p>
      </Ground>
    )
  }
  return (
    <Ground
      title={
        <span className="flex items-center gap-2.5">
          <span className="font-mono">{p.id}</span>
          <KindBadge kind={p.kind} large />
          <AreaChip id={p.area} />
        </span>
      }
      side={
        <Nav selected={p.id} onSelect={(id) => void navigate({ hash: id }, { replace: true })} />
      }
      flush
    >
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <div key={p.id} className="min-w-0 flex-1 overflow-auto">
          <Reference p={p} />
        </div>
        <div className="pane floating flex shrink-0 overflow-hidden">
          <CodePane p={p} />
        </div>
      </div>
    </Ground>
  )
}
