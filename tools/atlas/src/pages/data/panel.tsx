import { ChevronRight } from "lucide-react"
import { useState } from "react"

import { groupBy } from "../../atlas-data.ts"
import type { Anchor, Table } from "../../atlas.ts"
import { AnchorIcon } from "../../components/anchor.tsx"
import { AreaChip, Label, SidePanel } from "../api/shared.tsx"
import { isPk } from "./model.ts"

const ByFile = ({ anchors }: { anchors: Anchor[] }) =>
  anchors.length === 0 ? (
    <span className="text-[12px] text-muted">none</span>
  ) : (
    <div className="flex flex-wrap gap-x-2 gap-y-1">
      {groupBy(anchors, (a) => a.file).map(([file, group]) => (
        <span
          key={file}
          className="inline-flex items-center gap-0.5 rounded-sm border border-line px-1"
          title={file}
        >
          {group.map((a) => (
            <AnchorIcon key={`${a.file}:${a.line}`} anchor={a} size={12} />
          ))}
        </span>
      ))}
    </div>
  )

export const TablePanel = ({ table: t, onClose }: { table: Table; onClose: () => void }) => {
  const [sql, setSql] = useState(false)
  return (
    <SidePanel title={t.name} onClose={onClose}>
      <div className="flex items-center gap-2">
        <AreaChip id={t.area} />
        <span className="flex items-center gap-1 text-[11px] text-muted" title="definition">
          schema <AnchorIcon anchor={t.anchor} />
        </span>
        <span className="font-mono text-[11px] text-muted">{t.columns.length} cols</span>
      </div>
      <div>
        <Label>Readers {t.readers.length}</Label>
        <ByFile anchors={t.readers} />
      </div>
      <div>
        <Label>Writers {t.writers.length}</Label>
        <ByFile anchors={t.writers} />
      </div>
      <div>
        <button
          type="button"
          onClick={() => setSql(!sql)}
          className="flex cursor-pointer items-center gap-1 font-mono text-[11px] text-muted hover:text-fg"
        >
          <ChevronRight size={12} className={sql ? "rotate-90" : ""} /> sql
        </button>
        {sql ? (
          <pre className="mt-1 overflow-auto rounded-sm bg-raised p-2 font-mono text-[11px] leading-4">
            {t.sql}
          </pre>
        ) : null}
        {sql ? (
          <div className="mt-1 text-[10px] text-muted">
            {t.columns
              .filter(isPk)
              .map((c) => c.name)
              .join(", ")}
          </div>
        ) : null}
      </div>
    </SidePanel>
  )
}
