import type { Anchor, Procedure } from "../src/atlas.ts"
import type {
  ProcedureTrace,
  RunnerLens,
  SqlVerb,
  Statement,
  Step,
  StoreMethod,
  Touch,
} from "../src/lens-runner.ts"
import { sourceFiles } from "./files.ts"
import type { LensInput } from "./lens-input.ts"
import { findDefinition, routerFile, runnerDir, servicesOf } from "./runner-services.ts"

const storeFile = "application/runner/src/workspaces/store.ts"

const lineAt = (source: string, index: number): number => source.slice(0, index).split("\n").length

// Every string and template literal in `code` that reads as a SQL statement, with its
// offset. Interpolations become `?`; comments are skipped.
export const sqlIn = (code: string): { sql: string; at: number }[] => {
  const found: { sql: string; at: number }[] = []
  const template = (from: number): { text: string; end: number } => {
    let text = ""
    let i = from + 1
    while (i < code.length && code[i] !== "`") {
      if (code[i] === "\\") {
        text += code[i + 1] ?? ""
        i += 2
      } else if (code[i] === "$" && code[i + 1] === "{") {
        let depth = 1
        i += 2
        while (i < code.length && depth > 0) {
          if (code[i] === "{") depth += 1
          else if (code[i] === "}") depth -= 1
          else if (code[i] === "`") i = template(i).end
          i += 1
        }
        text += "?"
      } else text += code[i++]
    }
    return { text, end: i }
  }
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    if (ch === "/" && code[i + 1] === "/")
      i = code.indexOf("\n", i) === -1 ? code.length : code.indexOf("\n", i)
    else if (ch === "/" && code[i + 1] === "*") i = code.indexOf("*/", i) + 1
    else if (ch === "`") {
      const { text, end } = template(i)
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|REPLACE)\b/i.test(text))
        found.push({ sql: text.replace(/\s+/g, " ").trim(), at: i })
      i = end
    } else if (ch === '"' || ch === "'") {
      let j = i + 1
      while (j < code.length && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1
      const text = code.slice(i + 1, j)
      if (/^\s*(SELECT|INSERT|UPDATE|DELETE)\b/i.test(text))
        found.push({ sql: text.replace(/\s+/g, " ").trim(), at: i })
      i = j
    }
  }
  return found
}

// The tables a statement touches: its subject by its leading keyword, every other
// `FROM`/`JOIN` as a read.
export const touchesOf = (sql: string, tables: Set<string>): Touch[] => {
  const kind = sql.trim().split(/\s/)[0]!.toLowerCase()
  const subject =
    kind === "insert" || kind === "replace"
      ? /\bINTO\s+(\w+)/i.exec(sql)
      : kind === "update"
        ? /^\s*UPDATE\s+(?:OR\s+\w+\s+)?(\w+)/i.exec(sql)
        : kind === "delete"
          ? /\bDELETE\s+FROM\s+(\w+)/i.exec(sql)
          : null
  const verb: SqlVerb =
    kind === "delete" ? "delete" : kind === "select" || kind === "with" ? "read" : "write"
  const touches: Touch[] = []
  const add = (table: string | undefined, as: SqlVerb): void => {
    if (table && tables.has(table) && !touches.some((t) => t.table === table && t.verb === as))
      touches.push({ table, verb: as })
  }
  add(subject?.[1], verb)
  // A write that returns the row it wrote reads that table too.
  if (subject && /\bRETURNING\b/i.test(sql)) add(subject[1], "read")
  const rest = subject ? sql.replace(subject[0], " ") : sql
  for (const match of rest.matchAll(/\b(?:FROM|JOIN)\s+(\w+)/gi)) add(match[1], "read")
  return touches
}

const statementKind = (sql: string): Statement["kind"] => {
  const word = sql.trim().split(/\s/)[0]!.toLowerCase()
  return word === "insert" || word === "replace"
    ? "insert"
    : word === "update"
      ? "update"
      : word === "delete"
        ? "delete"
        : "select"
}

type Unit = {
  name: string
  // The class it is a method of, when it is one.
  owner: string | null
  prop: boolean
  file: string
  line: number
  body: string
  offset: number
}

// The class methods (two-space indent) and top-level functions of a file, with bodies.
const unitsIn = (file: string, source: string): Unit[] => {
  const lines = source.split("\n")
  const units: Unit[] = []
  let offset = 0
  const offsets = lines.map((text) => {
    const at = offset
    offset += text.length + 1
    return at
  })
  let owner: string | null = null
  lines.forEach((text, index) => {
    const declared = /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/.exec(text)
    if (declared) owner = declared[1]!
    else if (text.startsWith("}")) owner = null
    const method =
      /^ {2}(?:(?:async|private|public|static|protected|get|set|readonly)\s+)*\*?(\w+)\s*(?:<[^>]*>)?\(/.exec(
        text,
      ) ??
      /^ {2}(?:(?:private|public|protected|readonly)\s+)*(\w+)\s*=\s*(?:async\s*)?[(<]/.exec(text)
    const fn = /^(?:export\s+)?(?:async\s+)?function\*?\s+(\w+)/.exec(text)
    const prop = /^( {4,8})(\w+): (?:async )?\(/.exec(text)
    const name = method?.[1] ?? fn?.[1] ?? prop?.[2]
    if (!name || ["if", "for", "while", "switch", "catch", "constructor"].includes(name)) return
    const closes = method ? ["  }"] : prop ? [`${prop[1]}},`, `${prop[1]}}`] : ["}"]
    let end = index
    // A method written on one line ends there; otherwise at its closing brace.
    const oneLine =
      text.trimEnd().endsWith("}") &&
      text.split("{").length === text.split("}").length &&
      text.includes("{")
    if (!oneLine) while (end < lines.length && !closes.includes(lines[end]!)) end += 1
    units.push({
      name,
      owner: method ? owner : null,
      prop: Boolean(prop && !method && !fn),
      file,
      line: index + 1,
      body: lines.slice(index, end + 1).join("\n"),
      offset: offsets[index]!,
    })
  })
  // Methods and functions first, so a lookup by name finds them before an object's property.
  return units.toSorted((a, b) => Number(a.prop) - Number(b.prop))
}

const stem = (file: string): string => file.split("/").at(-1)!.replace(/\.ts$/, "")

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

export const extractRunnerLens = (input: LensInput): RunnerLens => {
  const { repo, anchors } = input
  const tables = input.data.tables.map((table) => table.name)
  const tableSet = new Set(tables)

  // The store: its methods, their statements, and the store methods they call.
  const storeSource = anchors.read(storeFile) ?? ""
  const classAt = storeSource.indexOf("export class WorkspaceStore")
  if (classAt === -1)
    anchors.report("store methods", storeFile, 'expected "export class WorkspaceStore"')
  const storeUnits = unitsIn(storeFile, classAt === -1 ? "" : storeSource.slice(classAt)).map(
    (unit) => ({
      ...unit,
      line: unit.line + lineAt(storeSource, classAt) - 1,
      offset: unit.offset + classAt,
    }),
  )
  const storeNames = new Set(storeUnits.map((unit) => unit.name))
  const methods: StoreMethod[] = storeUnits.map((unit) => {
    const statements = sqlIn(unit.body).map(({ sql, at }): Statement => ({
      sql,
      kind: statementKind(sql),
      touches: touchesOf(sql, tableSet),
      anchor: { file: storeFile, line: lineAt(storeSource, unit.offset + at) },
    }))
    const calls = [
      ...new Set([...unit.body.matchAll(/\bthis\.(\w+)\(/g)].map((m) => m[1]!)),
    ].filter((name) => storeNames.has(name) && name !== unit.name)
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
  const methodByName = new Map(methods.map((method) => [method.name, method]))

  // Every other runner unit, to follow a call from a service one or two hops in.
  const router = anchors.read(routerFile) ?? ""
  const services = servicesOf(anchors, router)
  const files = sourceFiles(repo, runnerDir).filter((file) => file !== storeFile)
  const unitsByFile = new Map(files.map((file) => [file, unitsIn(file, anchors.read(file) ?? "")]))
  const unitsNamed = (name: string): Unit[] =>
    [...unitsByFile.values()].flatMap((list) => list.filter((unit) => unit.name === name))
  const unitAt = (anchor: Anchor | null): Unit | undefined =>
    anchor === null
      ? undefined
      : unitsByFile.get(anchor.file)?.find((unit) => unit.line === anchor.line)

  // The store's shapes: WorkspaceStore, the types it declares it implements, and object
  // types in the runner made only of store methods, at least three of them
  // (`VoiceSettingsStore`). An unrelated `FooStore` with its own methods, or a one-method
  // lookup that happens to be called `project`, never counts as the store.
  const storeTypes = new Set([
    "WorkspaceStore",
    ...(/export class WorkspaceStore implements ([\w\s,]+)\{/.exec(storeSource)?.[1] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  ])
  for (const file of files)
    for (const match of (anchors.read(file) ?? "").matchAll(
      /^export type (\w+) = \{\n([\s\S]*?)^\}/gm,
    )) {
      const members = [...match[2]!.matchAll(/^ {2}(?:readonly\s+)?(\w+)\??\s*[(:<]/gm)].map(
        (member) => member[1]!,
      )
      if (members.length >= 3 && members.every((name) => storeNames.has(name)))
        storeTypes.add(match[1]!)
    }
  const typeAlternatives = [...storeTypes].join("|")

  // What a file calls the store: identifiers it declares with one of the store's types
  // (`store: WorkspaceStore`, `records?: TerminalRecords`) or assigns `new WorkspaceStore(`.
  // A name the file also uses for a Map or Set counts only behind another object
  // (`options.records`), never as `this.records`.
  const refsCache = new Map<string, { names: Set<string>; ambiguous: Set<string> }>()
  const refsIn = (file: string) => {
    const cached = refsCache.get(file)
    if (cached) return cached
    const text = anchors.read(file) ?? ""
    const names = new Set(
      [
        ...text.matchAll(
          new RegExp(`\\b(\\w+)\\??\\s*:\\s*(?:readonly\\s+)?(?:${typeAlternatives})\\b`, "g"),
        ),
        ...text.matchAll(/\b(\w+)\s*=\s*new WorkspaceStore\(/g),
      ].map((match) => match[1]!),
    )
    const ambiguous = new Set(
      [...names].filter((name) =>
        new RegExp(
          `\\b${name}\\b\\s*(?::[^=\\n]*)?=\\s*new (?:Map|Set)\\b|\\b${name}\\??:\\s*(?:Readonly)?(?:Map|Set)<`,
        ).test(text),
      ),
    )
    const made = { names, ambiguous }
    refsCache.set(file, made)
    return made
  }
  const isStoreRef = (file: string, receiver: string, direct: boolean): boolean => {
    const { names, ambiguous } = refsIn(file)
    return names.has(receiver) && !(direct && ambiguous.has(receiver))
  }

  // Store methods a body calls through a store reference of its file, not by name alone.
  const storeCalls = (body: string, file: string): string[] => [
    ...new Set(
      [...body.matchAll(/\b(\w+)\??\.(\w+)\(/g)]
        .filter(
          (match) =>
            methodByName.has(match[2]!) &&
            isStoreRef(
              file,
              match[1]!,
              body.slice(Math.max(0, match.index - 5), match.index) === "this.",
            ),
        )
        .map((match) => match[2]!),
    ),
  ]

  const trace = (procedure: Procedure): ProcedureTrace => {
    const id = procedure.id
    const at = router.indexOf(`authorized.${id}.handler(`)
    const start = at === -1 ? router.indexOf(`api.${id}.handler(`) : at
    if (start === -1) return { id, steps: [], reached: [], traced: false }
    const skip = start + id.length + 20
    const next = router.slice(skip).search(/\.handler\(/)
    const body = router.slice(start, next === -1 ? undefined : skip + next)
    const seen = new Set<string>()

    // `unit` and what it calls, as a flat list in call order. A branch that reaches no
    // store method is dropped, except the first hop, which shows where the trail ends.
    const visit = (unit: Unit, label: string, depth: number): Step[] => {
      const key = `${unit.file}:${unit.line}`
      if (seen.has(key)) return []
      seen.add(key)
      const inner: Step[] = []
      if (depth < 3) {
        for (const match of unit.body.matchAll(/(?<![\w$])(this\.)?(?:(\w+)\??\.)?(\w+)\(/g)) {
          const [, viaThis, receiver, name] = match
          if (!name || !viaThis || ["if", "for", "while", "switch", "catch"].includes(name))
            continue
          let found: Unit | undefined
          if (!receiver) {
            // The current class's own method first, whatever else shares its name.
            found = unitsByFile
              .get(unit.file)
              ?.find((each) => each.name === name && each.owner === unit.owner && each !== unit)
          } else if (!builtin.has(name) && !isStoreRef(unit.file, receiver, true)) {
            const only = unitsNamed(name)
            if (only.length === 1 && only[0] !== unit) found = only[0]
          }
          if (found) inner.push(...visit(found, `${stem(found.file)}.${name}`, depth + 1))
        }
      }
      const store = storeCalls(unit.body, unit.file)
      return store.length > 0 || inner.length > 0 || depth === 1
        ? [{ label, anchor: { file: unit.file, line: unit.line }, depth, store }, ...inner]
        : []
    }

    // The service methods the router handler calls: the API's resolved handler first.
    const hops: { unit: Unit; label: string }[] = []
    const chosen = procedure.handler?.file === routerFile ? undefined : unitAt(procedure.handler)
    for (const match of body.matchAll(/(?<![\w$.])(\w+)\??\.(\w+)\(/g)) {
      const service = services.find((each) => each.field === match[1])
      if (!service) continue
      const unit = unitAt(findDefinition(anchors, files, service, match[2]!))
      if (unit && !hops.some((hop) => hop.unit === unit))
        hops.push({ unit, label: `${service.type}.${match[2]}` })
    }
    if (chosen && !hops.some((hop) => hop.unit === chosen))
      hops.push({ unit: chosen, label: `${stem(chosen.file)}.${chosen.name}` })
    hops.sort((a, b) => Number(b.unit === chosen) - Number(a.unit === chosen))

    const steps: Step[] = [
      {
        label: `router: ${id}`,
        anchor: { file: routerFile, line: lineAt(router, start) },
        depth: 0,
        store: storeCalls(body, routerFile),
      },
      ...hops.flatMap((hop) => visit(hop.unit, hop.label, 1)),
    ]
    const reached: ProcedureTrace["reached"] = []
    const have = new Set<string>()
    const reach = (method: string, from: string | null, depth: number): void => {
      if (have.has(method) || depth > 2) return
      have.add(method)
      reached.push({ method, from })
      for (const call of methodByName.get(method)?.calls ?? []) reach(call, method, depth + 1)
    }
    for (const step of steps) for (const method of step.store) reach(method, null, 0)
    const traced = reached.some((r) => methodByName.get(r.method)!.statements.length > 0)
    return { id, steps, reached, traced }
  }

  const procedures = input.api.procedures.map(trace)
  for (const procedure of procedures)
    for (const { method } of procedure.reached) methodByName.get(method)!.usedBy.push(procedure.id)

  // Tables ordered by how much SQL touches them, so the hot ones lead.
  const heat = new Map(tables.map((table) => [table, 0]))
  for (const method of methods)
    for (const statement of method.statements)
      for (const touch of statement.touches) heat.set(touch.table, (heat.get(touch.table) ?? 0) + 1)

  return {
    tables: tables.toSorted((a, b) => heat.get(b)! - heat.get(a)!),
    methods: methods.filter((method) => method.statements.length > 0),
    procedures,
    statements: methods.reduce((sum, method) => sum + method.statements.length, 0),
  }
}
