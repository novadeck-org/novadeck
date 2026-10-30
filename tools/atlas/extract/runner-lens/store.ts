import type { Statement, StoreMethod, Touch } from "../../src/runner-lens.ts"
import { lineAt, type Anchors } from "../anchors.ts"
import { sqlIn, statementKind, touchesOf } from "./sql.ts"
import { unitsIn } from "./units.ts"

export const storeFile = "backend/runner/src/workspaces/store.ts"

export type Store = {
  source: string
  methods: StoreMethod[]
  byName: Map<string, StoreMethod>
}

// The workspace store: its methods, their statements, and the store methods they call.
export const readStore = (anchors: Anchors, tables: Set<string>): Store => {
  const source = anchors.read(storeFile) ?? ""
  const classAt = source.indexOf("export class WorkspaceStore")
  if (classAt === -1)
    anchors.report("store methods", storeFile, 'expected "export class WorkspaceStore"')
  const units = unitsIn(storeFile, classAt === -1 ? "" : source.slice(classAt)).map((unit) => ({
    ...unit,
    line: unit.line + lineAt(source, classAt) - 1,
    offset: unit.offset + classAt,
  }))
  const names = new Set(units.map((unit) => unit.name))
  const methods: StoreMethod[] = units.map((unit) => {
    const statements = sqlIn(unit.body).map(({ sql, at }): Statement => ({
      sql,
      kind: statementKind(sql),
      touches: touchesOf(sql, tables),
      anchor: { file: storeFile, line: lineAt(source, unit.offset + at) },
    }))
    const calls = [
      ...new Set([...unit.body.matchAll(/\bthis\.(\w+)\(/g)].map((m) => m[1]!)),
    ].filter((name) => names.has(name) && name !== unit.name)
    const merged = new Map<string, Touch>()
    const weight = new Map<string, number>()
    for (const statement of statements)
      for (const touch of statement.touches) {
        merged.set(`${touch.table}:${touch.verb}`, touch)
        weight.set(touch.table, (weight.get(touch.table) ?? 0) + (touch.verb === "read" ? 1 : 2))
      }
    const home = [...weight].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? null
    return {
      name: unit.name,
      anchor: { file: storeFile, line: unit.line },
      statements,
      calls,
      touches: [...merged.values()],
      home,
      usedBy: [],
    }
  })
  return { source, methods, byName: new Map(methods.map((method) => [method.name, method])) }
}
