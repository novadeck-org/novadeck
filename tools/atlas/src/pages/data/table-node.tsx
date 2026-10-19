import { Handle, Position } from "@xyflow/react"
import type { NodeProps } from "@xyflow/react"
import { Link2, KeyRound } from "lucide-react"
import { memo } from "react"

import { HEAD, NODE_W, ROW, isPk, relations } from "./model.ts"
import type { TableNode } from "./model.ts"

const fkCols = new Set(
  relations()
    .filter((r) => !r.implied)
    .map((r) => `${r.from}.${r.fromCol}`),
)
const impliedCols = new Set(
  relations()
    .filter((r) => r.implied)
    .map((r) => `${r.from}.${r.fromCol}`),
)

// Reader/writer counts as tiny bars: one tick per call site, capped.
const Ticks = ({ n, label }: { n: number; label: string }) => (
  <span className="flex items-center gap-0.5" title={`${n} ${label}`}>
    <span className="w-2 font-mono text-[8px] uppercase text-muted">{label[0]}</span>
    <span className="flex gap-px">
      {Array.from({ length: Math.min(n, 9) }, (_, i) => (
        <span key={i} className="h-2.5 w-[3px] bg-[var(--color-line-strong)]" />
      ))}
      {n === 0 ? <span className="h-2.5 w-[3px] border border-line" /> : null}
    </span>
  </span>
)

export const TableBox = memo(({ data }: NodeProps<TableNode>) => {
  const { table: t, selected, related } = data
  return (
    <div
      className={`rounded-sm border bg-panel shadow-[var(--shadow-control)] ${
        selected
          ? "border-accent"
          : related
            ? "border-[var(--color-line-strong)]"
            : "border-[var(--color-outline)]"
      }`}
      style={{ width: NODE_W }}
    >
      <div
        className="flex items-center justify-between gap-2 border-b border-line bg-raised px-2"
        style={{ height: HEAD }}
      >
        <span
          className={`truncate font-mono text-[12px] font-semibold ${selected ? "text-accent" : ""}`}
        >
          {t.name}
        </span>
        <span className="flex shrink-0 flex-col gap-px">
          <Ticks n={t.readers.length} label="readers" />
          <Ticks n={t.writers.length} label="writers" />
        </span>
      </div>
      <div className="pb-2">
        {t.columns.map((c) => {
          const key = `${t.name}.${c.name}`
          return (
            <div
              key={c.name}
              className="relative flex items-center gap-1 px-2"
              style={{ height: ROW }}
            >
              <span className="flex w-3 shrink-0 justify-center text-muted">
                {isPk(c) ? (
                  <KeyRound size={10} />
                ) : fkCols.has(key) ? (
                  <Link2 size={10} className="text-fg" />
                ) : impliedCols.has(key) ? (
                  <Link2 size={10} className="opacity-40" />
                ) : null}
              </span>
              <span className="truncate font-mono text-[11px]">{c.name}</span>
              <span className="ml-auto font-mono text-[10px] text-muted">
                {c.type.toLowerCase()}
              </span>
              {(["l", "r"] as const).map((side) => (
                <Handle
                  key={side}
                  id={`${c.name}-${side}`}
                  type="source"
                  position={side === "l" ? Position.Left : Position.Right}
                  style={{ opacity: 0, pointerEvents: "none" }}
                />
              ))}
            </div>
          )
        })}
      </div>
    </div>
  )
})
