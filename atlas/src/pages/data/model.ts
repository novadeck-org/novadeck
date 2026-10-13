import type { Node } from "@xyflow/react"

import { atlas, tableByName } from "../../atlas-data.ts"
import type { Table } from "../../atlas.ts"

export const NODE_W = 230
export const HEAD = 34
export const ROW = 18

export type TableData = { table: Table; selected: boolean; related: boolean }
export type TableNode = Node<TableData, "table">

export const nodeHeight = (t: Table) => HEAD + t.columns.length * ROW + 8

export const isPk = (c: { constraints: string }) => /PRIMARY KEY/i.test(c.constraints)

// Columns laid out left to right along the dependency chain; messaging gets its own column.
const COLUMNS: string[][] = [
  ["message_threads", "messages"],
  ["projects", "settings"],
  ["sessions", "terminal_numbers"],
  ["terminals", "companion_windows"],
  ["companion_items"],
]

export const positions = () => {
  const out = new Map<string, { x: number; y: number }>()
  const placed = new Set(COLUMNS.flat())
  const cols = [...COLUMNS]
  const extra = atlas.data.tables.filter((t) => !placed.has(t.name)).map((t) => t.name)
  if (extra.length) cols.push(extra)
  cols.forEach((names, ci) => {
    let y = 0
    for (const name of names) {
      const t = tableByName.get(name)
      if (!t) continue
      out.set(name, { x: ci * (NODE_W + 80), y })
      y += nodeHeight(t) + 36
    }
  })
  return out
}

export type Rel = {
  id: string
  from: string
  fromCol: string
  to: string
  toCol: string
  implied: boolean
}

const pkOf = (t: Table) => (t.columns.find((c) => c.name === "id") ?? t.columns[0])?.name ?? "id"

// Foreign keys from REFERENCES, plus `<x>_id` columns whose table exists by name.
export const relations = (): Rel[] => {
  const rels: Rel[] = []
  for (const t of atlas.data.tables)
    for (const c of t.columns) {
      let target = c.references
      let implied = false
      const m = /^(.+)_id$/.exec(c.name)
      if (!target && m) {
        const x = m[1]!
        target =
          [`${x}s`, x, `message_${x}s`].find((n) => tableByName.has(n) && n !== t.name) ?? null
        implied = true
      }
      const to = target ? tableByName.get(target) : undefined
      if (!to) continue
      rels.push({
        id: `${t.name}.${c.name}`,
        from: t.name,
        fromCol: c.name,
        to: to.name,
        toCol: pkOf(to),
        implied,
      })
    }
  return rels
}
