import type { RunnerLens } from "../src/runner-lens.ts"
import type { LensInput } from "./lens-input.ts"
import { storeReferences } from "./runner-lens/references.ts"
import { scanRunner } from "./runner-lens/scan.ts"
import { readStore } from "./runner-lens/store.ts"
import { traceProcedure } from "./runner-lens/trace.ts"

// The runner from the inside, read by scanning its source: each procedure's path from the
// router down to the SQL it runs, and the statements of the workspace store by method.
// Each part is read in `runner-lens/`; this file puts them together.

export const extractRunnerLens = (input: LensInput): RunnerLens => {
  const scan = scanRunner(input)
  const tables = input.data.tables.map((table) => table.name)
  const store = readStore(scan, new Set(tables))
  const references = storeReferences(scan, store)

  const procedures = input.api.procedures.map((procedure) =>
    traceProcedure(scan, store, references, procedure),
  )
  for (const procedure of procedures)
    for (const { method } of procedure.reached) store.byName.get(method)!.usedBy.push(procedure.id)

  // Tables ordered by how much SQL touches them, so the hot ones lead.
  const heat = new Map(tables.map((table) => [table, 0]))
  for (const method of store.methods)
    for (const statement of method.statements)
      for (const touch of statement.touches) heat.set(touch.table, (heat.get(touch.table) ?? 0) + 1)

  return {
    tables: tables.toSorted((a, b) => heat.get(b)! - heat.get(a)!),
    methods: store.methods.filter((method) => method.statements.length > 0),
    procedures,
    statements: store.methods.reduce((sum, method) => sum + method.statements.length, 0),
  }
}
