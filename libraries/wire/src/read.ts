/**
 * Reading what a peer of another build sent with a strict schema, dropping the keys it added
 * that the schema doesn't know: the runner reads its inputs so (`dropUnknownKeys`), and a UI
 * the answers it parses (`readTolerantly`). Only zod's schemas are read this way; any other is
 * read as strictly as it is.
 */

type Issue = { readonly code?: unknown; readonly keys?: unknown; readonly path?: unknown }
type Result = { readonly value?: unknown; readonly issues?: readonly Issue[] }
type Path = readonly PropertyKey[]

/** A schema read as Standard Schema says, as zod's and oRPC's are. */
export type Readable<T = unknown> = {
  readonly "~standard": {
    readonly types?: { readonly output: T } | undefined
    validate(value: unknown): unknown
  }
}

/** Told of the keys dropped from a value that then passed. */
export type Told = (keys: readonly string[]) => void

// Times a value is parsed again: each pass drops what the one before found, and zod finds
// every level's unknown keys at once, so a second is the last that can still find any.
const passes = 4

type Def = { readonly type: string; readonly [key: string]: unknown }

// A zod schema's definition, or `undefined` for a schema of another kind.
const defOf = (schema: unknown): Def | undefined => {
  const def = (schema as { readonly def?: unknown } | null | undefined)?.def
  return typeof def === "object" && def !== null && typeof (def as Def).type === "string"
    ? (def as Def)
    : undefined
}

const record = (value: unknown): Record<PropertyKey, unknown> | undefined =>
  typeof value === "object" && value !== null ? (value as Record<PropertyKey, unknown>) : undefined

// The options of a union `value` may be read by: in a discriminated one, those whose tag is
// `value`'s (zod reads it by that alone); else every one.
const optionsFor = (def: Def, value: unknown): readonly unknown[] => {
  const options = (def.options as readonly unknown[] | undefined) ?? []
  const tag = def.discriminator
  if (typeof tag !== "string") return options
  const given = record(value)?.[tag]
  const matching = options.filter((option) => {
    const shape = record(defOf(option)?.shape)
    const values = defOf(shape?.[tag])?.values
    return Array.isArray(values) && values.includes(given)
  })
  return matching.length > 0 ? matching : options
}

// The object schemas `value`'s part at `path` may be read by, through every way `schema`
// may read it: each option of a union, both sides of an intersection.
const objectsAt = (schema: unknown, path: Path, value: unknown, depth = 0): Def[] => {
  const def = defOf(schema)
  if (def === undefined || depth > 64) return []
  const next = (inner: unknown, rest: Path, part: unknown) =>
    objectsAt(inner, rest, part, depth + 1)
  switch (def.type) {
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
      return next(def.innerType, path, value)
    case "pipe":
      return next(def.in, path, value)
    case "lazy":
      return next((def.getter as () => unknown)(), path, value)
    case "union":
      return optionsFor(def, value).flatMap((option) => next(option, path, value))
    case "intersection":
      return [...next(def.left, path, value), ...next(def.right, path, value)]
    case "object": {
      const [head, ...rest] = path
      if (head === undefined) return [def]
      const shape = record(def.shape)
      return next(shape?.[head] ?? def.catchall, rest, record(value)?.[head])
    }
    case "array":
      return path.length === 0 ? [] : next(def.element, path.slice(1), record(value)?.[path[0]!])
    case "tuple": {
      if (path.length === 0) return []
      const items = (def.items as readonly unknown[] | undefined) ?? []
      return next(items[Number(path[0])] ?? def.rest, path.slice(1), record(value)?.[path[0]!])
    }
    case "record":
      return path.length === 0 ? [] : next(def.valueType, path.slice(1), record(value)?.[path[0]!])
    default:
      return []
  }
}

// The keys zod found at each place that no schema there names, or `undefined` when anything
// else is wrong, or a key one of a union's options names is among them: dropping it could
// change which option reads the value, and pass a field that one would refuse.
const droppable = (
  schema: unknown,
  value: unknown,
  issues: readonly Issue[],
): readonly { path: Path; keys: readonly string[] }[] | undefined => {
  if (defOf(schema) === undefined) return undefined
  const found: { path: Path; keys: readonly string[] }[] = []
  for (const issue of issues) {
    if (issue.code !== "unrecognized_keys" || !Array.isArray(issue.keys)) return undefined
    if (!Array.isArray(issue.path)) return undefined
    const path = issue.path as Path
    const keys = issue.keys as string[]
    const named = objectsAt(schema, path, value).some((def) => {
      const shape = record(def.shape) ?? {}
      return keys.some((key) => key in shape)
    })
    if (named) return undefined
    found.push({ path, keys })
  }
  return found
}

// `value` with `keys` taken out of the object at `path`, copying only what's on the way.
const without = (value: unknown, path: Path, keys: readonly string[]): unknown => {
  if (typeof value !== "object" || value === null) return value
  const [head, ...rest] = path
  if (head === undefined) {
    if (Array.isArray(value)) return value
    const copy: Record<PropertyKey, unknown> = { ...value }
    for (const key of keys) delete copy[key]
    return copy
  }
  if (Array.isArray(value)) {
    const copy = [...value]
    copy[Number(head)] = without(copy[Number(head)], rest, keys)
    return copy
  }
  const parts = value as Record<PropertyKey, unknown>
  return { ...parts, [head]: without(parts[head], rest, keys) }
}

/**
 * Validates `value` with `schema`, and when the only issues are keys no part of the schema
 * names, drops them and validates once more: every key it names is checked as strictly as
 * before. `told` hears of the keys dropped from a value that then passed.
 */
export const validateTolerantly = (
  schema: Readable,
  value: unknown,
  told: Told = () => {},
): Result | Promise<Result> => {
  const settle = (current: unknown, result: Result, pass: number, dropped: readonly string[]) => {
    if (result.issues === undefined) {
      if (dropped.length > 0) told([...new Set(dropped)])
      return result
    }
    const found = pass < passes ? droppable(schema, current, result.issues) : undefined
    if (found === undefined) return result
    const kept = found.reduce((part, { path, keys }) => without(part, path, keys), current)
    return run(kept, pass + 1, [...dropped, ...found.flatMap(({ keys }) => keys)])
  }
  const run = (
    current: unknown,
    pass: number,
    dropped: readonly string[],
  ): Result | Promise<Result> => {
    const result = schema["~standard"].validate(current) as Result | Promise<Result>
    return result instanceof Promise
      ? result.then((settled) => settle(current, settled, pass, dropped))
      : settle(current, result, pass, dropped)
  }
  return run(value, 1, [])
}

/**
 * What a UI reads an answer or an error's data with, where it parses one at all: `schema`'s
 * value, with keys a newer runner added dropped, or `undefined` when it doesn't fit. The UI
 * otherwise never validates what it reads, which the contract's check counts on.
 */
export const readTolerantly = <T>(schema: Readable<T>, value: unknown): T | undefined => {
  const result = validateTolerantly(schema, value)
  return result instanceof Promise || result.issues !== undefined ? undefined : (result.value as T)
}
