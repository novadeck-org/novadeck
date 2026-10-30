import type { Anchor, Procedure } from "../../src/atlas.ts"
import type { ProcedureTrace, Step } from "../../src/runner-lens.ts"
import { lineAt } from "../anchors.ts"
import { stem } from "../files.ts"
import { findDefinition, handlerBody, routerFile } from "../runner-services.ts"
import type { StoreReferences } from "./references.ts"
import type { RunnerScan } from "./scan.ts"
import type { Store } from "./store.ts"
import type { Unit } from "./units.ts"

// A procedure's path down to the store: the router handler, the service methods it calls,
// what they call a hop or two further, and the store methods those reach.

type Tracer = RunnerScan & { store: Store; references: StoreReferences }

// Method names too common to follow from a receiver: collections, promises, emitters.
const builtin = new Set([
  "get",
  "set",
  "has",
  "delete",
  "map",
  "filter",
  "push",
  "add",
  "clear",
  "values",
  "keys",
  "find",
  "some",
  "every",
  "forEach",
  "includes",
  "slice",
  "join",
  "then",
  "catch",
  "close",
  "on",
  "off",
  "emit",
  "send",
  "write",
  "read",
  "start",
  "stop",
  "run",
  "all",
  "next",
  "reduce",
])

// `unit` and what it calls, as a flat list in call order. A branch that reaches no store
// method is dropped, except the first hop, which shows where the trail ends.
const visit = (
  tracer: Tracer,
  seen: Set<string>,
  unit: Unit,
  label: string,
  depth: number,
): Step[] => {
  const key = `${unit.file}:${unit.line}`
  if (seen.has(key)) return []
  seen.add(key)
  const inner: Step[] = []
  if (depth < 3) {
    for (const match of unit.body.matchAll(/(?<![\w$])(this\.)?(?:(\w+)\??\.)?(\w+)\(/g)) {
      const [, viaThis, receiver, name] = match
      if (!name || !viaThis || ["if", "for", "while", "switch", "catch"].includes(name)) continue
      let found: Unit | undefined
      if (!receiver) {
        // The current class's own method first, whatever else shares its name.
        found = tracer.unitsByFile
          .get(unit.file)
          ?.find((each) => each.name === name && each.owner === unit.owner && each !== unit)
      } else if (!builtin.has(name) && !tracer.references.isStore(unit.file, receiver, true)) {
        const only = [...tracer.unitsByFile.values()].flatMap((list) =>
          list.filter((each) => each.name === name),
        )
        if (only.length === 1 && only[0] !== unit) found = only[0]
      }
      if (found) inner.push(...visit(tracer, seen, found, `${stem(found.file)}.${name}`, depth + 1))
    }
  }
  const store = tracer.references.callsIn(unit.body, unit.file)
  return store.length > 0 || inner.length > 0 || depth === 1
    ? [{ label, anchor: { file: unit.file, line: unit.line }, depth, store }, ...inner]
    : []
}

// The service methods the router handler calls: the API's resolved handler first.
const serviceHops = (
  tracer: Tracer,
  body: string,
  handler: Anchor | null,
): { unit: Unit; label: string }[] => {
  const unitAt = (anchor: Anchor | null): Unit | undefined =>
    anchor === null
      ? undefined
      : tracer.unitsByFile.get(anchor.file)?.find((unit) => unit.line === anchor.line)
  const hops: { unit: Unit; label: string }[] = []
  const chosen = handler?.file === routerFile ? undefined : unitAt(handler)
  for (const match of body.matchAll(/(?<![\w$.])(\w+)\??\.(\w+)\(/g)) {
    const service = tracer.services.find((each) => each.field === match[1])
    if (!service) continue
    const unit = unitAt(findDefinition(tracer.anchors, tracer.files, service, match[2]!))
    if (unit && !hops.some((hop) => hop.unit === unit))
      hops.push({ unit, label: `${service.type}.${match[2]}` })
  }
  if (chosen && !hops.some((hop) => hop.unit === chosen))
    hops.push({ unit: chosen, label: `${stem(chosen.file)}.${chosen.name}` })
  return hops.toSorted((a, b) => Number(b.unit === chosen) - Number(a.unit === chosen))
}

// Every store method the steps reach, with the store method that called it (null: a service
// called it directly), following store methods calling each other two hops down.
const reachedMethods = (store: Store, steps: Step[]): ProcedureTrace["reached"] => {
  const reached: ProcedureTrace["reached"] = []
  const have = new Set<string>()
  const reach = (method: string, from: string | null, depth: number): void => {
    if (have.has(method) || depth > 2) return
    have.add(method)
    reached.push({ method, from })
    for (const call of store.byName.get(method)?.calls ?? []) reach(call, method, depth + 1)
  }
  for (const step of steps) for (const method of step.store) reach(method, null, 0)
  return reached
}

export const traceProcedure = (
  scan: RunnerScan,
  store: Store,
  references: StoreReferences,
  procedure: Procedure,
): ProcedureTrace => {
  const tracer: Tracer = { ...scan, store, references }
  const id = procedure.id
  const handler = handlerBody(tracer.router, id)
  if (handler === null) return { id, steps: [], reached: [], traced: false }
  const seen = new Set<string>()
  const steps: Step[] = [
    {
      label: `router: ${id}`,
      anchor: { file: routerFile, line: lineAt(tracer.router, handler.start) },
      depth: 0,
      store: tracer.references.callsIn(handler.body, routerFile),
    },
    ...serviceHops(tracer, handler.body, procedure.handler).flatMap((hop) =>
      visit(tracer, seen, hop.unit, hop.label, 1),
    ),
  ]
  const reached = reachedMethods(tracer.store, steps)
  const traced = reached.some((r) => tracer.store.byName.get(r.method)!.statements.length > 0)
  return { id, steps, reached, traced }
}
