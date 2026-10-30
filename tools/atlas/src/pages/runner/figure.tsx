import { clsx } from "clsx"
import { useState } from "react"
import type { CSSProperties, ReactNode } from "react"

import type { SqlVerb, Touch } from "../../runner-lens.ts"
import { Tile, VerbGlyph, verbName } from "./glyphs.tsx"
import {
  isTraced,
  lens,
  litBy,
  methodGroups,
  namespaceReach,
  namespaces,
  tableHeat,
  verbs,
} from "./model.ts"
import type { Selection } from "./model.ts"

const columns = `minmax(250px, 310px) repeat(${lens.tables.length}, minmax(0, 1fr)) 52px`
const grid: CSSProperties = { gridTemplateColumns: columns }
const maxStatements = Math.max(...[...tableHeat.values()].map((h) => h.statements), 1)

const Cell = ({
  verbs: have,
  strength = 0,
  focus,
  title,
  on,
}: {
  verbs: Set<SqlVerb> | undefined
  // 0..1, how much of the surface reaches here.
  strength?: number | undefined
  // The table column that is picked.
  focus: boolean
  title?: string | undefined
  // A selection owns this cell, so its marks take the accent.
  on: boolean
}) => (
  <div
    title={title}
    className="flex items-center justify-center gap-[3px] border-l border-line/60"
    style={{
      background: focus
        ? "color-mix(in srgb, var(--accent) 9%, transparent)"
        : strength > 0
          ? `color-mix(in srgb, var(--color-ink) ${Math.round(4 + strength * 14)}%, transparent)`
          : undefined,
      color: on ? "var(--accent)" : "var(--color-ink)",
    }}
  >
    {have
      ? verbs.filter((verb) => have.has(verb)).map((verb) => <VerbGlyph key={verb} verb={verb} />)
      : null}
  </div>
)

const Header = ({
  sel,
  onPick,
  lit,
}: {
  sel: Selection
  onPick: (s: Selection) => void
  lit: ReturnType<typeof litBy>
}) => (
  <div
    className="sticky top-0 z-[3] grid items-end border-b border-line"
    style={{ ...grid, background: "var(--color-paper)" }}
  >
    <div className="flex h-full items-end gap-4 px-3 pb-2 text-caption text-muted">
      {verbs.map((verb) => (
        <span key={verb} className="flex items-center gap-1.5">
          <VerbGlyph verb={verb} />
          {verb}
        </span>
      ))}
    </div>
    {lens.tables.map((table) => {
      const heat = tableHeat.get(table)!
      const picked = sel?.kind === "table" && sel.id === table
      const dim = lit !== null && !lit.tables.has(table)
      return (
        <button
          key={table}
          type="button"
          onClick={() => onPick(picked ? null : { kind: "table", id: table })}
          aria-pressed={picked}
          title={`${table}: ${heat.statements} statements, ${heat.procs} procedures reach it`}
          className={clsx(
            "group flex min-w-0 cursor-pointer flex-col items-center justify-end gap-1 border-l border-line/60 pt-2 pb-2 transition-opacity",
            dim && "opacity-35",
          )}
          style={
            picked ? { background: "color-mix(in srgb, var(--accent) 9%, transparent)" } : undefined
          }
        >
          <span className="font-mono text-caption leading-none tabular-nums">
            {heat.statements}
          </span>
          <span className="flex h-7 w-3 items-end rounded-sm bg-soft">
            <span
              className="block w-full rounded-sm"
              style={{
                height: `${Math.max(8, (heat.statements / maxStatements) * 100)}%`,
                background: picked ? "var(--accent)" : "var(--color-line-strong)",
              }}
            />
          </span>
          <span
            className={clsx(
              "font-mono text-label leading-none whitespace-nowrap group-hover:text-fg",
              picked ? "text-fg" : "text-muted",
            )}
            style={{ writingMode: "vertical-rl", transform: "rotate(180deg)", height: 100 }}
          >
            {table}
          </span>
        </button>
      )
    })}
    <div className="px-1 pb-2 text-center text-label text-muted">procs</div>
  </div>
)

const Band = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="flex items-baseline gap-2 border-b border-dashed border-line bg-fill px-3 py-1.5">
    <span className="section-label">{children}</span>
    <span className="text-caption text-muted">{aside}</span>
  </div>
)

export const Figure = ({
  sel,
  onPick,
  onHover,
}: {
  sel: Selection
  onPick: (s: Selection) => void
  onHover: (id: string | null) => void
}) => {
  const lit = litBy(sel)
  const [all, setAll] = useState(false)
  // A procedure or a table narrows the store rows to what it reaches; a method keeps
  // them all, to stand in its place.
  const narrow = lit !== null && sel?.kind !== "method" && !all
  const tracedCount = namespaces.reduce(
    (n, [, list]) => n + list.filter((p) => isTraced(p.id)).length,
    0,
  )
  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <Header sel={sel} onPick={onPick} lit={lit} />
      <Band
        aside={`${tracedCount} of ${namespaces.reduce((n, [, l]) => n + l.length, 0)} reach SQL`}
      >
        API surface
      </Band>
      {namespaces.map(([ns, list]) => {
        const shown = lit ? list.filter((p) => lit.procs.has(p.id)) : list
        const reach = namespaceReach(shown)
        const traced = list.filter((p) => isTraced(p.id)).length
        // What the selection does not touch folds to a line, to leave room below.
        const folded = lit !== null && shown.length === 0
        return (
          <div key={ns} className="grid border-b border-line/60" style={grid}>
            <div
              className={clsx(
                "flex min-w-0 gap-2.5 px-3",
                folded ? "items-center py-[3px]" : "items-start py-2",
              )}
            >
              <div className="w-[74px] shrink-0 pt-px">
                <div
                  className={clsx(
                    "truncate font-mono leading-4",
                    folded ? "text-caption" : "text-control",
                  )}
                >
                  {ns}
                </div>
              </div>
              <div className={clsx("flex gap-[3px]", !folded && "flex-wrap")}>
                {list.map((p) => {
                  const on = sel?.kind === "procedure" && sel.id === p.id
                  const dim = lit !== null && !lit.procs.has(p.id)
                  return (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onPick(on ? null : { kind: "procedure", id: p.id })}
                      onMouseEnter={() => onHover(p.id)}
                      onMouseLeave={() => onHover(null)}
                      onFocus={() => onHover(p.id)}
                      onBlur={() => onHover(null)}
                      aria-pressed={on}
                      aria-label={`${p.id}, ${isTraced(p.id) ? "reaches SQL" : "no store call found"}`}
                      className={clsx(
                        "cursor-pointer rounded-sm transition-opacity hover:bg-soft",
                        folded ? "p-px" : "p-[2px]",
                        dim && "opacity-30",
                      )}
                      style={
                        on ? { outline: "1.5px solid var(--accent)", outlineOffset: 0 } : undefined
                      }
                    >
                      <Tile
                        traced={isTraced(p.id)}
                        stream={p.kind === "stream"}
                        size={folded ? 10 : 16}
                      />
                    </button>
                  )
                })}
              </div>
            </div>
            {lens.tables.map((table) => {
              const cell = reach.get(table)
              return (
                <Cell
                  key={table}
                  verbs={cell?.verbs}
                  strength={cell ? Math.min(1, cell.procs / 6) : 0}
                  focus={sel?.kind === "table" && sel.id === table}
                  on={sel !== null && sel.kind !== "table"}
                  title={
                    cell
                      ? `${ns}: ${cell.procs} ${cell.procs === 1 ? "procedure" : "procedures"} ${[...cell.verbs].map((v) => verbName[v]).join(", ")} ${table}`
                      : undefined
                  }
                />
              )
            })}
            <div className="flex items-center justify-center border-l border-line/60 font-mono text-caption tabular-nums text-muted">
              {traced}/{list.length}
            </div>
          </div>
        )
      })}
      <Band
        aside={
          <>
            {lens.methods.length} methods, {lens.statements} statements in workspaces/store.ts
            {lit !== null && sel?.kind !== "method" ? (
              <button
                type="button"
                onClick={() => setAll(!all)}
                className="ml-3 cursor-pointer text-fg underline decoration-line-strong underline-offset-2 hover:decoration-fg"
              >
                {all ? "only what is lit" : "show all"}
              </button>
            ) : null}
          </>
        }
      >
        Store calls
      </Band>
      {methodGroups.map(([table, full]) => {
        const list = narrow ? full.filter((m) => lit.methods.has(m.name)) : full
        return list.length === 0 ? null : (
          <div key={table}>
            <div className="px-3 pt-2.5 pb-1 font-mono text-label tracking-wide text-muted uppercase">
              {table}
            </div>
            {list.map((method) => {
              const on = sel?.kind === "method" && sel.id === method.name
              const dim = lit !== null && !lit.methods.has(method.name)
              const touches = new Map<string, Set<SqlVerb>>()
              for (const { table: t, verb } of method.touches as Touch[])
                touches.set(t, (touches.get(t) ?? new Set()).add(verb))
              return (
                <button
                  key={method.name}
                  type="button"
                  data-selected={on}
                  onClick={() => onPick(on ? null : { kind: "method", id: method.name })}
                  className={clsx(
                    "item grid w-full items-stretch text-left transition-opacity",
                    dim && "opacity-30",
                  )}
                  style={grid}
                >
                  <span className="flex min-w-0 items-center gap-2 py-[2px] pr-2 pl-5 font-mono text-control">
                    <span className="truncate">{method.name}</span>
                    {method.statements.length > 1 ? (
                      <span className="text-label text-muted">×{method.statements.length}</span>
                    ) : null}
                  </span>
                  {lens.tables.map((t) => (
                    <Cell
                      key={t}
                      verbs={touches.get(t)}
                      focus={sel?.kind === "table" && sel.id === t}
                      on={
                        on ||
                        (lit !== null && sel?.kind === "procedure" && lit.methods.has(method.name))
                      }
                    />
                  ))}
                  <span className="flex items-center justify-center border-l border-line/60 font-mono text-caption tabular-nums text-muted">
                    {method.usedBy.length || "·"}
                  </span>
                </button>
              )
            })}
          </div>
        )
      })}
      <div className="h-6" />
    </div>
  )
}
