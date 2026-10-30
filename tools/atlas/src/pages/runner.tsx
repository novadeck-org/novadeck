import { useState } from "react"
import { useLocation } from "react-router"

import { procedureById } from "../atlas-data.ts"
import { StackStrip } from "../components/stack.tsx"
import { Ground, Stat } from "../components/ui.tsx"
import { hashId } from "../links.ts"
import { Detail } from "./runner/detail.tsx"
import { Figure } from "./runner/figure.tsx"
import { lens } from "./runner/model.ts"
import type { Selection } from "./runner/model.ts"

import "./visual-tokens.css"

export const RunnerPage = () => {
  const { hash } = useLocation()
  const wanted = hashId(hash)
  const [sel, setSel] = useState<Selection>(
    procedureById.has(wanted) ? { kind: "procedure", id: wanted } : null,
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
          <StackStrip token="backend/runner" />
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
