import { ContractProcedure, type AnyContractRouter, type AnySchema } from "@orpc/contract"

type Issue = { readonly code?: unknown; readonly keys?: unknown; readonly path?: unknown }
type Result = { readonly value?: unknown; readonly issues?: readonly Issue[] }
type Path = readonly PropertyKey[]

/** Told of the keys an input had that its schema doesn't name, by the procedure's path. */
export type Dropped = (procedure: readonly string[], keys: readonly string[]) => void

// Times an input is parsed again: each pass drops what the one before found, and zod finds
// every level's unknown keys at once, so a second is the last that can still find any.
const passes = 4

// The keys zod found that the schema doesn't name, where it found them: or `undefined` when
// anything else is wrong too, which dropping keys can't fix.
const unknownKeys = (
  issues: readonly Issue[],
): readonly { path: Path; keys: readonly string[] }[] | undefined => {
  const found = issues.map((issue) =>
    issue.code === "unrecognized_keys" && Array.isArray(issue.keys) && Array.isArray(issue.path)
      ? { path: issue.path as Path, keys: issue.keys as string[] }
      : undefined,
  )
  return found.every((entry) => entry !== undefined) ? found : undefined
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
  const record = value as Record<PropertyKey, unknown>
  return { ...record, [head]: without(record[head], rest, keys) }
}

const tolerate = (schema: AnySchema, report: (keys: readonly string[]) => void): AnySchema => {
  const standard = schema["~standard"]
  const settle = (value: unknown, result: Result, pass: number): Result | Promise<Result> => {
    const found = result.issues && unknownKeys(result.issues)
    if (!found || pass >= passes) return result
    report([...new Set(found.flatMap(({ keys }) => keys))])
    const kept = found.reduce((current, { path, keys }) => without(current, path, keys), value)
    return run(kept, pass + 1)
  }
  const run = (value: unknown, pass: number): Result | Promise<Result> => {
    const result = standard.validate(value) as Result | Promise<Result>
    return result instanceof Promise
      ? result.then((settled) => settle(value, settled, pass))
      : settle(value, result, pass)
  }
  return {
    "~standard": { ...standard, validate: (value: unknown) => run(value, 1) as never },
  } as AnySchema
}

/**
 * `contract` with each procedure's input taking keys it doesn't name and dropping them, for a
 * server that serves clients newer than itself: a field one added that this server doesn't
 * know is left out before its handler runs, never passed on. Every key the schema names is
 * checked as strictly as before; an input with anything else wrong is refused as it was,
 * unknown keys and all. Parsing costs nothing more for an input with no unknown keys. Only the
 * schemas the server validates inputs with change: the contract's own, which other code may
 * parse with, stay strict.
 */
export const dropUnknownKeys = <C extends AnyContractRouter>(
  contract: C,
  dropped: Dropped = () => {},
): C => {
  const walk = (node: unknown, path: readonly string[]): unknown => {
    if (node instanceof ContractProcedure) {
      const def = node["~orpc"]
      if (def.inputSchema === undefined) return node
      const inputSchema = tolerate(def.inputSchema, (keys) => dropped(path, keys))
      return new ContractProcedure({ ...def, inputSchema })
    }
    if (typeof node !== "object" || node === null) return node
    return Object.fromEntries(
      Object.entries(node).map(([key, inner]) => [key, walk(inner, [...path, key])]),
    )
  }
  return walk(contract, []) as C
}
