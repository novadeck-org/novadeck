import { atlas, groupBy } from "../../atlas-data.ts"
import type { Procedure } from "../../atlas.ts"
import type { ProcedureTrace, SqlVerb, StoreMethod } from "../../lens-runner.ts"

export const lens = atlas.runner

export const procedures = atlas.api.procedures
export const traceOf = new Map<string, ProcedureTrace>(lens.procedures.map((t) => [t.id, t]))
export const methodOf = new Map<string, StoreMethod>(lens.methods.map((m) => [m.name, m]))
export const procedureOf = new Map<string, Procedure>(procedures.map((p) => [p.id, p]))

export const verbs: SqlVerb[] = ["read", "write", "delete"]
export type Verbs = Set<SqlVerb>

export type Selection = { kind: "procedure" | "method" | "table"; id: string } | null

export const namespaces: [string, Procedure[]][] = groupBy(procedures, (p) => p.namespace)

// The store methods with SQL a procedure reaches.
export const reachedBy = (id: string): StoreMethod[] =>
  (traceOf.get(id)?.reached ?? []).flatMap((r) => {
    const method = methodOf.get(r.method)
    return method ? [method] : []
  })

// What a set of store methods does to each table.
export const touchMap = (methods: StoreMethod[]): Map<string, Verbs> => {
  const map = new Map<string, Verbs>()
  for (const method of methods)
    for (const { table, verb } of method.touches) {
      const have = map.get(table) ?? new Set<SqlVerb>()
      have.add(verb)
      map.set(table, have)
    }
  return map
}

export const procTouches = new Map(procedures.map((p) => [p.id, touchMap(reachedBy(p.id))]))

export const isTraced = (id: string): boolean => traceOf.get(id)?.traced ?? false

// A namespace's reach into each table: the verbs, and how many of its procedures.
export const namespaceReach = (list: Procedure[]): Map<string, { verbs: Verbs; procs: number }> => {
  const map = new Map<string, { verbs: Verbs; procs: number }>()
  for (const p of list)
    for (const [table, v] of procTouches.get(p.id) ?? []) {
      const have = map.get(table) ?? { verbs: new Set<SqlVerb>(), procs: 0 }
      for (const verb of v) have.verbs.add(verb)
      have.procs += 1
      map.set(table, have)
    }
  return map
}

export const tableHeat = new Map(
  lens.tables.map((table) => [
    table,
    {
      statements: lens.methods.reduce(
        (n, m) => n + m.statements.filter((s) => s.touches.some((t) => t.table === table)).length,
        0,
      ),
      procs: procedures.filter((p) => procTouches.get(p.id)?.has(table)).length,
    },
  ]),
)

// Matrix rows grouped by the table each method mostly works on, hottest table first.
export const methodGroups: [string, StoreMethod[]][] = lens.tables.flatMap((table) => {
  const list = lens.methods.filter((m) => m.home === table)
  return list.length > 0 ? [[table, list] as [string, StoreMethod[]]] : []
})

export type Lit = { procs: Set<string>; methods: Set<string>; tables: Set<string> } | null

// What a selection lights up on the other layers.
export const litBy = (sel: Selection): Lit => {
  if (!sel) return null
  if (sel.kind === "procedure") {
    const methods = reachedBy(sel.id)
    return {
      procs: new Set([sel.id]),
      methods: new Set(methods.map((m) => m.name)),
      tables: new Set(procTouches.get(sel.id)?.keys()),
    }
  }
  if (sel.kind === "method") {
    const method = methodOf.get(sel.id)
    return {
      procs: new Set(method?.usedBy),
      methods: new Set([sel.id]),
      tables: new Set(method?.touches.map((t) => t.table)),
    }
  }
  return {
    procs: new Set(procedures.filter((p) => procTouches.get(p.id)?.has(sel.id)).map((p) => p.id)),
    methods: new Set(
      lens.methods.filter((m) => m.touches.some((t) => t.table === sel.id)).map((m) => m.name),
    ),
    tables: new Set([sel.id]),
  }
}
