import { useState } from "react"
import { useLocation } from "react-router"

import { StackStrip } from "../components/stack.tsx"
import { Ground } from "../components/ui.tsx"
import { hashId } from "../links.ts"
import { Detail } from "./runner/detail.tsx"
import { Figure } from "./runner/figure.tsx"
import { lens, procedureOf } from "./runner/model.ts"
import type { Selection } from "./runner/model.ts"

import "./visual-tokens.css"

const Stat = ({ n, children }: { n: number; children: string }) => (
  <span className="flex items-baseline gap-1">
    <span className="font-mono text-body font-medium text-fg tabular-nums">{n}</span>
    {children}
  </span>
)

export const RunnerPage = () => {
  const { hash } = useLocation()
  const wanted = hashId(hash)
  const [sel, setSel] = useState<Selection>(
    procedureOf.has(wanted) ? { kind: "procedure", id: wanted } : null,
  )
  const [hovered, setHovered] = useState<string | null>(null)
  const traced = lens.procedures.filter((p) => p.traced).length
  return (
    <Ground
      flush
      title="Runner"
      tools={
        <>
          <div className="pane floating flex h-9 items-center gap-4 px-3 text-caption text-muted">
            <Stat n={lens.procedures.length}>procedures</Stat>
            <Stat n={traced}>reach SQL</Stat>
            <Stat n={lens.procedures.length - traced}>none found</Stat>
            <Stat n={lens.statements}>statements</Stat>
            <Stat n={lens.tables.length}>tables</Stat>
          </div>
          <StackStrip token="runner" />
        </>
      }
    >
      <div className="flex min-h-0 flex-1 gap-3 px-3 pb-3">
        <section className="pane flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Figure sel={sel} onPick={setSel} onHover={setHovered} />
        </section>
        <Detail sel={sel} hovered={hovered} onPick={setSel} />
      </div>
    </Ground>
  )
}
