import type { RunnerLens } from "../src/runner-lens.ts"
import { sourceFiles } from "./files.ts"
import type { LensInput } from "./lens-input.ts"
import { storeReferences } from "./runner-lens/references.ts"
import { readStore, storeFile } from "./runner-lens/store.ts"
import { traceProcedure } from "./runner-lens/trace.ts"
import { unitsIn } from "./runner-lens/units.ts"
import { routerFile, runnerDir, servicesOf } from "./runner-services.ts"

// The runner from the inside, read by scanning its source: each procedure's path from the
// router down to the SQL it runs, and the statements of the workspace store by method.
// Each part is read in `runner-lens/`; this file puts them together.

export const extractRunnerLens = (input: LensInput): RunnerLens => {
  const { repo, anchors } = input
  const tables = input.data.tables.map((table) => table.name)
  const store = readStore(anchors, new Set(tables))

  // Every other runner unit, to follow a call from a service one or two hops in.
  const router = anchors.read(routerFile) ?? ""
  const files = sourceFiles(repo, runnerDir).filter((file) => file !== storeFile)
  const tracer = {
    anchors,
    router,
    services: servicesOf(anchors, router),
    files,
    unitsByFile: new Map(files.map((file) => [file, unitsIn(file, anchors.read(file) ?? "")])),
    store,
    references: storeReferences(anchors, files, store),
  }

  const procedures = input.api.procedures.map((procedure) => traceProcedure(tracer, procedure))
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
