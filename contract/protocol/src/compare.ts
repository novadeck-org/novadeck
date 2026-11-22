// Compares a contract with the one a release had (`contract.json`, see snapshot.ts), and judges
// whether the window moved as far as the change needs. It runs in scripts/compatibility, under Node
// alone, so it imports nothing but types.
import type { ContractSnapshot, JsonSchema, ProcedureSnapshot } from "./snapshot.js"

/** The peer from the release before that a change leaves behind: its UI or its runner. */
export type Behind = "ui" | "runner"

export type Finding = {
  /** The procedure's dotted path, or `errors.<CODE>` for an error's data. */
  readonly procedure: string
  readonly behind: Behind
  /** Where in the procedure: `input`, `output` or `yields`, then the schema's own path. */
  readonly at: string
  readonly reason: string
}

export type Verdict = {
  /** What the change does to a peer from the release before. */
  readonly findings: readonly Finding[]
  /** Procedures new since the release that a UI must check for (`since`), so older runners lack them by design. */
  readonly gated: readonly string[]
  /** What the window gets wrong for these findings; the check fails on any. */
  readonly problems: readonly string[]
}

const annotations = new Set([
  "$comment",
  "$id",
  "$schema",
  "default",
  "deprecated",
  "description",
  "examples",
  "id",
  "readOnly",
  "title",
  "writeOnly",
])

// The keywords zod writes (`z.toJSONSchema`, draft 2020-12) and snapshot.ts's two marks. A
// schema with any other is reported as a break both ways: this check can't tell.
const understood = new Set([
  ...annotations,
  "$defs",
  "$ref",
  "additionalProperties",
  "allOf",
  "anyOf",
  "const",
  "contentEncoding",
  "enum",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "items",
  "maxItems",
  "maxLength",
  "maxProperties",
  "maximum",
  "minItems",
  "minLength",
  "minProperties",
  "minimum",
  "multipleOf",
  "not",
  "oneOf",
  "pattern",
  "prefixItems",
  "properties",
  "propertyNames",
  "required",
  "type",
  "x-optional",
  "x-open",
  "x-zod",
])

type Schema = { readonly [keyword: string]: unknown }
type Problem = { readonly at: string; readonly reason: string }

const shown = (values: readonly unknown[]): string =>
  values.map((value) => JSON.stringify(value)).join(", ")

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

const constraints = (schema: Schema): string[] =>
  Object.keys(schema).filter((key) => !annotations.has(key) && key !== "$defs")

const isNever = (schema: Schema): boolean =>
  isSchema(schema.not) && constraints(schema.not).length === 0

const withoutKeys = (schema: Schema, keys: readonly string[]): Schema =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)))

const pointer = (root: Schema, ref: string): Schema => {
  if (!ref.startsWith("#")) throw new Error(`A $ref outside its schema: ${ref}`)
  let node: unknown = root
  for (const part of ref.slice(1).split("/").filter(Boolean))
    node = isSchema(node) ? node[part.replaceAll("~1", "/").replaceAll("~0", "~")] : undefined
  if (!isSchema(node)) throw new Error(`A $ref to nothing: ${ref}`)
  return node
}

type Types = ReadonlySet<string> | undefined

const typesOf = (schema: Schema, values: readonly unknown[] | undefined): Types => {
  if (typeof schema.type === "string") return new Set([schema.type])
  if (Array.isArray(schema.type)) return new Set(schema.type as string[])
  if (values === undefined) return undefined
  return new Set(
    values.map((value) =>
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value,
    ),
  )
}

const valuesOf = (schema: Schema): readonly unknown[] | undefined =>
  "const" in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined

const takesType = (types: ReadonlySet<string>, type: string): boolean =>
  types.has(type) || (type === "integer" && types.has("number"))

const number = (value: unknown): number | undefined =>
  typeof value === "number" ? value : undefined

// A bound as a number and whether it is exclusive; no bound is infinite.
const lower = (schema: Schema): readonly [number, boolean] => {
  const inclusive = number(schema.minimum)
  const exclusive = number(schema.exclusiveMinimum)
  if (exclusive !== undefined && (inclusive === undefined || exclusive >= inclusive))
    return [exclusive, true]
  return [inclusive ?? -Infinity, false]
}

const upper = (schema: Schema): readonly [number, boolean] => {
  const inclusive = number(schema.maximum)
  const exclusive = number(schema.exclusiveMaximum)
  if (exclusive !== undefined && (inclusive === undefined || exclusive <= inclusive))
    return [exclusive, true]
  return [inclusive ?? Infinity, false]
}

// Whether a single known value passes the wider schema's own bounds.
const fits = (wide: Schema, value: unknown): boolean => {
  if (typeof value === "string") {
    // zod counts UTF-16 code units, as `length` does.
    const { length } = value
    return length >= (number(wide.minLength) ?? 0) && length <= (number(wide.maxLength) ?? Infinity)
  }
  if (typeof value === "number") {
    const [low, lowOpen] = lower(wide)
    const [high, highOpen] = upper(wide)
    return (lowOpen ? value > low : value >= low) && (highOpen ? value < high : value <= high)
  }
  return true
}

/**
 * Who reads a value: the runner, which validates what it's sent against its schema, or the UI,
 * which never validates what it reads, so only what its types say can trip it: which fields
 * are there, their types, and which values a field takes. Bounds, patterns and formats it
 * never looks at, and an integer is a number to it.
 */
type Reader = "validates" | "trusts"

/**
 * Where `narrow` takes a value `wide` refuses, as `reader` sees it: an empty list when
 * everything `narrow` takes, `wide` takes too. Keys `wide` doesn't name are taken, as the side
 * that reads them drops or ignores them. When it can't tell, it says so, as a problem: never
 * a pass.
 */
/**
 * How an older UI reads the open schemas (`x-open`, open.ts) of the release it is from: a new
 * value or variant in one passes once every UI in the window reads it so (its `since` is at
 * most `oldestClient`), and a mark only stays as it was released.
 */
type Marks = { readonly oldestClient: number; readonly released: number }

type Mark = { readonly since?: unknown }

const markOf = (schema: Schema): Mark | undefined =>
  isSchema(schema["x-open"]) ? (schema["x-open"] as Mark) : undefined

const covers = (
  wideRoot: Schema,
  narrowRoot: Schema,
  reader: Reader,
  marks?: Marks,
): ((wide: Schema, narrow: Schema, at: string) => Problem[]) => {
  const bounds = reader === "validates"
  // Whether an older UI reads a value or variant of `wide` it doesn't know tolerantly.
  const opens = (wide: Schema): boolean => {
    const since = markOf(wide)?.since
    return marks !== undefined && typeof since === "number" && since <= marks.oldestClient
  }
  // Inside a union told apart by keys alone, a runner refuses a key an option doesn't name:
  // zod can't say which option failed only on it, so nothing drops it. Counted while the walk
  // is in one, as unions nest.
  let keyed = 0
  // The pairs being compared on the way here: a recursive schema that meets one again is
  // assumed to hold there, as the rest of the walk decides.
  const open = new Map<Schema, Set<Schema>>()

  const resolve = (schema: Schema, root: Schema): Schema => {
    let current = schema
    for (let depth = 0; typeof current.$ref === "string"; depth += 1) {
      if (depth > 32) throw new Error("A $ref that never ends")
      const target = pointer(root, current.$ref)
      const siblings = withoutKeys(current, ["$ref"])
      // The target itself where nothing but annotations sits beside the $ref, so a recursive
      // schema meets the same object again and the walk ends.
      current = constraints(siblings).length === 0 ? target : { ...target, ...siblings }
    }
    return current
  }

  const check = (wideGiven: Schema, narrowGiven: Schema, at: string): Problem[] => {
    const wide = resolve(wideGiven, wideRoot)
    const narrow = resolve(narrowGiven, narrowRoot)
    const pending = open.get(wide) ?? new Set()
    if (pending.has(narrow)) return []
    if (at.split("/").length > 200) return [{ at, reason: "is nested too deep to compare" }]
    open.set(wide, pending.add(narrow))
    try {
      return compare(wide, narrow, at)
    } finally {
      pending.delete(narrow)
    }
  }

  const discriminator = (options: readonly Schema[]): string | undefined => {
    const [first] = options
    if (first === undefined || !isSchema(first.properties)) return undefined
    return Object.keys(first.properties).find((key) => {
      const values = options.map((option) => {
        const property = isSchema(option.properties) ? option.properties[key] : undefined
        return isSchema(property) && "const" in property
          ? JSON.stringify(property.const)
          : undefined
      })
      return values.every((value) => value !== undefined) && new Set(values).size === values.length
    })
  }

  const tag = (schema: Schema, key: string | undefined): unknown => {
    const property =
      key !== undefined && isSchema(schema.properties) ? schema.properties[key] : undefined
    return isSchema(property) ? property.const : undefined
  }

  const compare = (wide: Schema, narrow: Schema, at: string): Problem[] => {
    const problem = (reason: string): Problem[] => [{ at, reason }]

    // The same schema takes the same values (a $ref may point elsewhere in each, so not then).
    const plainly = !JSON.stringify([wide, narrow]).includes('"$ref"')
    if (plainly && same(wide, narrow)) return []
    const unknown = [...Object.keys(wide), ...Object.keys(narrow)].filter(
      (key) => !understood.has(key),
    )
    if (unknown.length > 0)
      return problem(`uses ${[...new Set(unknown)].join(", ")}, which this check can't compare`)
    if (wide["x-zod"] !== narrow["x-zod"])
      return problem(
        `is ${String(narrow["x-zod"] ?? "a JSON value")} where it was ${String(wide["x-zod"] ?? "a JSON value")}`,
      )
    const optional: Problem[] =
      narrow["x-optional"] === true && wide["x-optional"] !== true ? problem("may be left out") : []
    // A released mark stays as it was; a new one names a revision after the release's, as the
    // release's UIs don't read it so.
    if (marks !== undefined) {
      const was = markOf(wide)
      const now = markOf(narrow)
      if (was !== undefined && !same(was, now))
        optional.push(...problem("changed or lost the open mark a release had"))
      const since = now?.since
      if (
        was === undefined &&
        now !== undefined &&
        (typeof since !== "number" || since <= marks.released)
      )
        optional.push(
          ...problem(
            `is marked open since ${String(since)}, which the release's UIs don't read so`,
          ),
        )
    }
    if (isNever(narrow)) return optional
    if (isNever(wide)) return [...optional, ...problem("takes a value where it took none")]

    const narrowOptions = narrow.anyOf ?? narrow.oneOf
    if (Array.isArray(narrowOptions)) {
      const rest = withoutKeys(narrow, ["anyOf", "oneOf", "x-optional"])
      const options = (narrowOptions as Schema[]).map((option) => resolve(option, narrowRoot))
      const key = discriminator(options)
      return [
        ...optional,
        ...options.flatMap((option, index) => {
          const value = tag(option, key)
          const label = value === undefined ? String(index) : `${key}=${JSON.stringify(value)}`
          return check(wide, { ...rest, ...option }, `${at}/${label}`)
        }),
      ]
    }
    if (Array.isArray(narrow.allOf)) {
      const rest = withoutKeys(narrow, ["allOf", "x-optional"])
      const tries = (narrow.allOf as Schema[]).map((part) => check(wide, { ...rest, ...part }, at))
      return [
        ...optional,
        ...(tries.some((found) => found.length === 0)
          ? []
          : (tries.toSorted((a, b) => a.length - b.length)[0] ?? [])),
      ]
    }
    const wideOptions = wide.anyOf ?? wide.oneOf
    if (Array.isArray(wideOptions)) {
      const rest = withoutKeys(wide, ["anyOf", "oneOf", "x-optional"])
      const bare = withoutKeys(narrow, ["x-optional"])
      const options = (wideOptions as Schema[]).map((option) => resolve(option, wideRoot))
      // A discriminated union is matched by its tag: a variant it didn't have is said as one.
      const key = discriminator(options)
      const value = tag(bare, key)
      if (key !== undefined && value !== undefined) {
        const match = options.find((option) => same(tag(option, key), value))
        if (match === undefined)
          return opens(wide)
            ? optional
            : [...optional, ...problem(`adds the ${JSON.stringify(value)} variant of "${key}"`)]
        return [...optional, ...check({ ...rest, ...match }, bare, at)]
      }
      // A nullable value's union reads its value as its one option would.
      const nullable =
        options.length === 2 && options.some((option) => same(option, { type: "null" }))
      const strict = reader === "validates" && !nullable
      if (strict) keyed += 1
      const tries = (() => {
        try {
          return options.map((option) => check({ ...rest, ...option }, bare, at))
        } finally {
          if (strict) keyed -= 1
        }
      })()
      if (tries.some((found) => found.length === 0)) return optional
      const closest = tries.toSorted((a, b) => a.length - b.length)[0] ?? []
      return [...optional, ...problem("matches none of the options it had"), ...closest]
    }
    if (Array.isArray(wide.allOf)) {
      const rest = withoutKeys(wide, ["allOf"])
      return [
        ...optional,
        ...(wide.allOf as Schema[]).flatMap((part) => check({ ...rest, ...part }, narrow, at)),
      ]
    }
    return [...optional, ...plain(wide, narrow, at)]
  }

  const plain = (wide: Schema, narrow: Schema, at: string): Problem[] => {
    // A schema with no constraints takes anything.
    if (constraints(withoutKeys(wide, ["x-optional"])).length === 0) return []
    const problems: Problem[] = []
    const say = (reason: string, where = at) => problems.push({ at: where, reason })

    const wideValues = valuesOf(wide)
    const narrowValues = valuesOf(narrow)
    const wideTypes = typesOf(wide, wideValues)
    const narrowTypes = typesOf(narrow, narrowValues)
    if (wideTypes !== undefined) {
      if (narrowTypes === undefined) {
        say(`takes any type, where it took ${[...wideTypes].join(" or ")}`)
        return problems
      }
      for (const type of narrowTypes)
        if (
          !takesType(wideTypes, type) &&
          (bounds || type !== "number" || !wideTypes.has("integer"))
        )
          say(`takes ${type}, where it took ${[...wideTypes].join(" or ")}`)
    }
    if (wideValues !== undefined) {
      if (narrowValues === undefined) say(`takes values beyond ${shown(wideValues)}`)
      else {
        const added = narrowValues.filter(
          (value) => !wideValues.some((known) => same(known, value)),
        )
        if (added.length > 0 && !opens(wide))
          say(`takes ${shown(added)}, beyond ${shown(wideValues)}`)
      }
    }
    // A schema of known values is judged by its values alone.
    if (narrowValues !== undefined) {
      const outside = bounds ? narrowValues.filter((value) => !fits(wide, value)) : []
      if (outside.length > 0) say(`takes ${shown(outside)}, outside its bounds`)
      return problems
    }
    const types = narrowTypes ?? new Set(["string", "number", "integer", "array", "object"])

    const bounded = (low: string, high: string, what: string) => {
      if (!bounds) return
      const wideLow = number(wide[low]) ?? 0
      const narrowLow = number(narrow[low]) ?? 0
      const wideHigh = number(wide[high]) ?? Infinity
      const narrowHigh = number(narrow[high]) ?? Infinity
      if (narrowLow < wideLow) say(`takes ${what} below ${wideLow}`)
      if (narrowHigh > wideHigh) say(`takes ${what} above ${wideHigh}`)
    }

    if (types.has("string")) {
      bounded("minLength", "maxLength", "a length")
      for (const keyword of bounds ? ["pattern", "format", "contentEncoding"] : [])
        if (wide[keyword] !== undefined && wide[keyword] !== narrow[keyword])
          say(
            `takes strings beyond ${keyword} ${JSON.stringify(wide[keyword])}${narrow[keyword] === undefined ? "" : ` (now ${JSON.stringify(narrow[keyword])})`}`,
          )
    }

    if (bounds && (types.has("number") || types.has("integer"))) {
      const [wideLow, wideLowOpen] = lower(wide)
      const [narrowLow, narrowLowOpen] = lower(narrow)
      if (narrowLow < wideLow || (narrowLow === wideLow && wideLowOpen && !narrowLowOpen))
        say(`takes numbers below ${wideLow}`)
      const [wideHigh, wideHighOpen] = upper(wide)
      const [narrowHigh, narrowHighOpen] = upper(narrow)
      if (narrowHigh > wideHigh || (narrowHigh === wideHigh && wideHighOpen && !narrowHighOpen))
        say(`takes numbers above ${wideHigh}`)
      const step = number(wide.multipleOf)
      const narrowStep = number(narrow.multipleOf) ?? (types.has("number") ? undefined : 1)
      if (step !== undefined && (narrowStep === undefined || narrowStep % step !== 0))
        say(`takes numbers that aren't multiples of ${step}`)
    }

    if (types.has("array")) {
      bounded("minItems", "maxItems", "an item count")
      const widePrefix = Array.isArray(wide.prefixItems) ? (wide.prefixItems as Schema[]) : []
      const narrowPrefix = Array.isArray(narrow.prefixItems) ? (narrow.prefixItems as Schema[]) : []
      const itemOf = (schema: Schema, prefix: readonly Schema[], index: number): Schema | false =>
        prefix[index] ??
        (schema.items === false ? false : isSchema(schema.items) ? schema.items : {})
      for (let index = 0; index < Math.max(widePrefix.length, narrowPrefix.length); index += 1) {
        const narrowItem = itemOf(narrow, narrowPrefix, index)
        if (narrowItem === false) continue
        const wideItem = itemOf(wide, widePrefix, index)
        if (wideItem === false)
          say(`takes an item at ${index}, past the items it took`, `${at}/${index}`)
        else problems.push(...check(wideItem, narrowItem, `${at}/${index}`))
      }
      if (narrow.items !== false) {
        const narrowItems = isSchema(narrow.items) ? narrow.items : {}
        if (wide.items === false) say("takes more items than it took")
        else
          problems.push(
            ...check(isSchema(wide.items) ? wide.items : {}, narrowItems, `${at}/items`),
          )
      }
    }

    if (types.has("object")) {
      bounded("minProperties", "maxProperties", "a key count")
      const wideProperties = isSchema(wide.properties) ? wide.properties : {}
      const narrowProperties = isSchema(narrow.properties) ? narrow.properties : {}
      const narrowRequired = new Set(
        Array.isArray(narrow.required) ? (narrow.required as string[]) : [],
      )
      for (const key of Array.isArray(wide.required) ? (wide.required as string[]) : [])
        if (!narrowRequired.has(key)) say("may be left out", `${at}/${key}`)
      const wideRest = isSchema(wide.additionalProperties) ? wide.additionalProperties : undefined
      const narrowRest = isSchema(narrow.additionalProperties)
        ? narrow.additionalProperties
        : undefined
      for (const [key, inner] of Object.entries(narrowProperties)) {
        if (!isSchema(inner)) continue
        const known = wideProperties[key]
        if (isSchema(known)) problems.push(...check(known, inner, `${at}/${key}`))
        // A key the wider side doesn't name is dropped or ignored there, unless it's a record,
        // or the runner reads it in a union told apart by keys.
        else if (wideRest !== undefined) problems.push(...check(wideRest, inner, `${at}/${key}`))
        else if (keyed > 0 && wide.additionalProperties === false)
          say("is a key a union told apart by its keys refuses", `${at}/${key}`)
      }
      if (narrowRest !== undefined) {
        if (Object.keys(wideProperties).length > 0 && wideRest === undefined)
          say("is a record where it was an object with named keys")
        if (wideRest !== undefined) {
          problems.push(...check(wideRest, narrowRest, `${at}/*`))
          const names = (schema: Schema): Schema =>
            isSchema(schema.propertyNames) ? schema.propertyNames : { type: "string" }
          problems.push(...check(names(wide), names(narrow), `${at}/(key)`))
        }
      }
    }
    return problems
  }

  return check
}

const nothing: JsonSchema = { "x-optional": true, not: {} }

const compareSchemas = (
  wide: JsonSchema,
  narrow: JsonSchema,
  at: string,
  reader: Reader,
  marks?: Marks,
): Problem[] => {
  try {
    return covers(wide, narrow, reader, marks)(wide, narrow, at)
  } catch (error) {
    return [{ at, reason: error instanceof Error ? error.message : String(error) }]
  }
}

const answer = (procedure: ProcedureSnapshot): readonly [string, JsonSchema] =>
  procedure.yields === undefined ? ["output", procedure.output ?? {}] : ["yields", procedure.yields]

/**
 * What `after` does to a UI and a runner of the release `before` was: what an older UI sends
 * must still pass the newer runner, and what it reads must still be there; what an older runner
 * reads and sends, the same for a newer UI. New procedures marked `since` a later revision than
 * `before` are left out, as a UI asks for them only of runners that have them.
 */
export const compareContracts = (
  before: ContractSnapshot,
  after: ContractSnapshot,
): { readonly findings: readonly Finding[]; readonly gated: readonly string[] } => {
  const findings: Finding[] = []
  const gated: string[] = []
  const found = (procedure: string, behind: Behind, problems: readonly Problem[]) =>
    findings.push(...problems.map(({ at, reason }) => ({ procedure, behind, at, reason })))

  // An older UI reads what a newer runner answers as its own release's marks say.
  const marks: Marks = { oldestClient: after.oldestClient, released: before.revision }
  for (const [path, old] of Object.entries(before.procedures)) {
    const now = after.procedures[path]
    if (now === undefined) {
      found(path, "ui", [{ at: "", reason: "is gone, which an older UI may still call" }])
      continue
    }
    if (now.since !== old.since)
      found(path, "runner", [
        { at: "since", reason: "changed its `since`, which a release already had" },
      ])
    // An input is the runner's to read, an answer the UI's.
    found(path, "ui", compareSchemas(now.input, old.input, "input", "validates"))
    found(path, "runner", compareSchemas(old.input, now.input, "input", "validates"))
    const [oldKind, oldAnswer] = answer(old)
    const [nowKind, nowAnswer] = answer(now)
    if (oldKind !== nowKind) {
      const problem = [
        { at: nowKind, reason: `is a ${nowKind === "yields" ? "stream" : "call"} now` },
      ]
      found(path, "ui", problem)
      found(path, "runner", problem)
      continue
    }
    found(path, "ui", compareSchemas(oldAnswer, nowAnswer, nowKind, "trusts", marks))
    found(path, "runner", compareSchemas(nowAnswer, oldAnswer, nowKind, "trusts"))
  }
  for (const [path, now] of Object.entries(after.procedures)) {
    if (path in before.procedures) continue
    if (now.since !== undefined && now.since > before.revision) gated.push(path)
    else
      found(path, "runner", [
        {
          at: "",
          reason: `is new, which an older runner doesn't have: mark it since: ${after.revision} for UIs to check`,
        },
      ])
  }
  for (const [code, old] of Object.entries(before.errors)) {
    const now = after.errors[code]
    if (now === undefined) continue
    // An error's data is read as an answer is; data the reader never looked for is ignored.
    if (old !== null)
      found(`errors.${code}`, "ui", compareSchemas(old, now ?? nothing, "data", "trusts", marks))
    if (now !== null)
      found(`errors.${code}`, "runner", compareSchemas(now, old ?? nothing, "data", "trusts"))
  }
  return { findings, gated }
}

const shape = ({ errors, procedures }: ContractSnapshot) => JSON.stringify({ errors, procedures })

/**
 * Whether `after`'s window fits what it changed since `before`, the release it builds on: a
 * changed contract raises the revision; a change that leaves an older UI or runner behind moves
 * that side's edge past `before`'s revision, so the handshake refuses that peer instead.
 */
export const judgeContract = (before: ContractSnapshot, after: ContractSnapshot): Verdict => {
  const { findings, gated } = compareContracts(before, after)
  const problems: string[] = []
  const was = before.revision
  if (shape(before) !== shape(after) && after.revision <= was)
    problems.push(
      `The contract changed since revision ${was}, but revision is still ${after.revision}: raise it to ${was + 1}.`,
    )
  for (const [edge, behind, peer] of [
    ["oldestClient", "ui", "UIs"],
    ["oldestRunner", "runner", "runners"],
  ] as const) {
    if (after[edge] < before[edge])
      problems.push(
        `${edge} fell from ${before[edge]} to ${after[edge]}: an edge only moves forward.`,
      )
    if (after[edge] > after.revision)
      problems.push(`${edge} (${after[edge]}) is past the revision (${after.revision}).`)
    const left = findings.filter((finding) => finding.behind === behind)
    if (left.length > 0 && after[edge] <= was)
      problems.push(
        `${left.length} change(s) leave ${peer} of revision ${was} behind, but ${edge} is ${after[edge]}: make them additive (docs/backend-api.md, "Versions"), or raise ${edge} to ${Math.max(was + 1, after.revision)} so the handshake refuses those ${peer}.`,
      )
  }
  for (const path of gated) {
    const since = after.procedures[path]?.since ?? 0
    if (since > after.revision)
      problems.push(`${path} is marked since: ${since}, past the revision (${after.revision}).`)
  }
  return { findings, gated, problems }
}

/** A release's contract, as `contract.json` holds it there, by the ref it was read from. */
export type Release = { readonly ref: string; readonly contract: ContractSnapshot }

/** A judgment against each release still in the window, the newest's as `judgeContract` gives. */
export type WindowVerdict = Verdict & {
  /** What `after` leaves behind of each older release still in its window, where anything. */
  readonly older: readonly {
    readonly ref: string
    readonly revision: number
    readonly findings: readonly Finding[]
  }[]
}

/**
 * `judgeContract` against the newest of `releases` (newest first), and against each older one
 * whose UIs or runners `after`'s window still takes. What holds against one release needn't
 * hold against an older one: an optional field gone and back with another type passes each
 * step, and breaks a peer of the first.
 */
export const judgeReleases = (
  releases: readonly Release[],
  after: ContractSnapshot,
): WindowVerdict => {
  const [newest, ...rest] = releases
  if (newest === undefined) return { findings: [], gated: [], problems: [], older: [] }
  const verdict = judgeContract(newest.contract, after)
  const problems = [...verdict.problems]
  const older: { ref: string; revision: number; findings: readonly Finding[] }[] = []
  const sides = [
    ["ui", "oldestClient", "UIs"],
    ["runner", "oldestRunner", "runners"],
  ] as const
  for (const { ref, contract } of rest) {
    const { revision } = contract
    const open = sides.filter(([, edge]) => revision >= after[edge])
    if (open.length === 0) continue
    const findings = compareContracts(contract, after).findings.filter((finding) =>
      open.some(([behind]) => behind === finding.behind),
    )
    if (findings.length === 0) continue
    older.push({ ref, revision, findings })
    for (const [behind, edge, peer] of open) {
      const left = findings.filter((finding) => finding.behind === behind).length
      if (left > 0)
        problems.push(
          `${left} change(s) leave ${peer} of revision ${revision} (${ref}) behind, which ${edge} ${after[edge]} still takes: make them additive, or raise ${edge} to ${revision + 1}.`,
        )
    }
  }
  return { ...verdict, problems, older }
}
