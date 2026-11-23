import { WireError } from "./errors.js"

type Node = { readonly [key: string]: unknown }

const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null

const isProcedure = (node: unknown): node is { readonly "~orpc": { readonly meta?: Node } } =>
  isNode(node) && "~orpc" in node

/** The revision a procedure came in, as its meta says (`.meta({ since })`), if it says. */
export const sinceOf = (node: unknown): number | undefined => {
  const since = isProcedure(node) ? node["~orpc"].meta?.since : undefined
  return typeof since === "number" ? since : undefined
}

const newest = (node: unknown): number => {
  if (isProcedure(node)) return sinceOf(node) ?? 0
  return isNode(node) ? Math.max(0, ...Object.values(node).map(newest)) : 0
}

/** The procedure at `path` of `contract`, or `undefined` when it has none there. */
export const procedureAt = (contract: unknown, path: readonly string[]): unknown => {
  let node = contract
  for (const key of path) node = isNode(node) && !isProcedure(node) ? node[key] : undefined
  return isProcedure(node) ? node : undefined
}

/**
 * Whether a server of `revision` has the procedure at `path`: one marked `since` a later
 * revision came after it. A path the contract doesn't name is no procedure it has.
 */
export const serves = (contract: unknown, path: readonly string[], revision: number): boolean => {
  const procedure = procedureAt(contract, path)
  return procedure !== undefined && (sinceOf(procedure) ?? 0) <= revision
}

type Def = { readonly type: string; readonly [key: string]: unknown }
// An input that isn't a zod schema, such as `type<T>()`'s, has no def and no marks.
const defOf = (schema: unknown): Def =>
  (schema as { readonly def?: Def } | undefined)?.def ?? { type: "none" }

// The revisions an input enum's values, or a discriminated union's variants, came in, which
// `inputEnum` and `inputUnion` (`@novadeck/protocol`) put in the schema's meta.
const marksOf = (schema: unknown): Readonly<Record<string, number>> | undefined => {
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined }).meta?.()
  const mark = meta?.["x-since"]
  return isNode(mark) ? (mark as Readonly<Record<string, number>>) : undefined
}

const wrappers = new Set([
  "optional",
  "nullable",
  "default",
  "prefault",
  "readonly",
  "catch",
  "nonoptional",
])

// A schema's options, for the one that holds a key.
const optionsOf = (def: Def): readonly unknown[] =>
  def.type === "union" && Array.isArray(def.options) ? (def.options as unknown[]) : []

// What `key` of an input's schema holds: an object's key, `*` for a list's items or a record's
// values, through optional and nullable wrappers and a union's options. The wrappers it passed
// come with it, as a mark may sit on any.
const descend = (schema: unknown, key: string): unknown => {
  const def = defOf(schema)
  if (wrappers.has(def.type)) return descend(def.innerType, key)
  if (def.type === "pipe") return descend(def.in, key)
  if (def.type === "lazy") return descend((def.getter as () => unknown)(), key)
  if (def.type === "array") return key === "*" ? def.element : undefined
  if (def.type === "record") return key === "*" ? def.valueType : undefined
  if (def.type === "object") return isNode(def.shape) ? def.shape[key] : undefined
  for (const option of optionsOf(def)) {
    const found = descend(option, key)
    if (found !== undefined) return found
  }
  return undefined
}

// The mark of the enum or union `schema` is, through its wrappers.
const markThrough = (schema: unknown): Readonly<Record<string, number>> | undefined => {
  const def = defOf(schema)
  const own = marksOf(schema)
  if (own) return own
  if (wrappers.has(def.type)) return markThrough(def.innerType)
  if (def.type === "pipe") return markThrough(def.in)
  if (def.type === "lazy") return markThrough((def.getter as () => unknown)())
  return undefined
}

const inputSchemaOf = (procedure: unknown): unknown =>
  (procedure as { readonly "~orpc": { readonly inputSchema?: unknown } })["~orpc"].inputSchema

/**
 * Whether a server of `revision` takes `value` at `at` of the input of the procedure at `path`:
 * not one an input enum or union marks as new since a later revision (`inputEnum`,
 * `inputUnion`). `at` names keys of the input with `.` between them, `*` for a list's items,
 * `"harness"` or `"options.harnesses.*"`; for a union, `value` is the variant's tag value. A
 * value with no mark, or a place the input doesn't have, is taken; a procedure the contract
 * lacks isn't.
 */
export const servesValue = (
  contract: unknown,
  path: readonly string[],
  at: string,
  value: string,
  revision: number,
): boolean => {
  const procedure = procedureAt(contract, path)
  if (procedure === undefined) return false
  let node = inputSchemaOf(procedure)
  for (const key of at === "" ? [] : at.split(".")) {
    if (node === undefined) return true
    node = descend(node, key)
  }
  const since = node === undefined ? undefined : markThrough(node)?.[value]
  return typeof since !== "number" || since <= revision
}

type Violation = { readonly at: string; readonly value: string; readonly since: number }
type Check = (value: unknown, revision: number, at: readonly string[]) => Violation | undefined
// A check, with the newest revision any value it looks for came in.
type Guard = { readonly check: Check; readonly newest: number }

const record = (value: unknown): Record<string, unknown> | undefined =>
  isNode(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// How to find, in an input of `schema`, a value marked new since a revision later than a
// server's; `undefined` when the schema marks none. A schema that meets itself again is
// walked once.
const checkerOf = (schema: unknown): Guard | undefined => {
  let latest = 0
  const making = new Map<unknown, { check: Check | undefined }>()

  const make = (node: unknown): Check | undefined => {
    const pending = making.get(node)
    if (pending) return (value, revision, at) => pending.check?.(value, revision, at)
    const def = defOf(node)
    const mark = marksOf(node)
    if (def.type === "enum") return mark && markCheck(mark, (value) => value)
    if (def.type === "union" && typeof def.discriminator === "string")
      return variantCheck(def, def.discriminator, mark)
    if (wrappers.has(def.type)) {
      const inner = make(def.innerType)
      return (
        inner && ((value, revision, at) => (value == null ? undefined : inner(value, revision, at)))
      )
    }
    switch (def.type) {
      case "pipe":
        return make(def.in)
      case "lazy": {
        const slot: { check: Check | undefined } = { check: undefined }
        making.set(node, slot)
        slot.check = make((def.getter as () => unknown)())
        return slot.check
      }
      case "object": {
        const fields = Object.entries(record(def.shape) ?? {}).flatMap(([key, field]) => {
          const check = make(field)
          return check ? [[key, check] as const] : []
        })
        if (fields.length === 0) return undefined
        return (value, revision, at) => {
          const given = record(value)
          if (!given) return undefined
          for (const [key, check] of fields) {
            if (!(key in given)) continue
            const found = check(given[key], revision, [...at, key])
            if (found) return found
          }
          return undefined
        }
      }
      case "array": {
        const item = make(def.element)
        return (
          item &&
          ((value, revision, at) =>
            Array.isArray(value) ? first(value, item, revision, at) : undefined)
        )
      }
      case "record": {
        const item = make(def.valueType)
        return (
          item &&
          ((value, revision, at) => {
            const given = record(value)
            return given ? first(Object.values(given), item, revision, at) : undefined
          })
        )
      }
      case "union": {
        const checks = optionsOf(def).flatMap((option) => {
          const check = make(option)
          return check ? [check] : []
        })
        if (checks.length === 0) return undefined
        return (value, revision, at) => {
          for (const check of checks) {
            const found = check(value, revision, at)
            if (found) return found
          }
          return undefined
        }
      }
      default:
        return undefined
    }
  }

  const first = (
    items: readonly unknown[],
    check: Check,
    revision: number,
    at: readonly string[],
  ) => {
    for (const item of items) {
      const found = check(item, revision, [...at, "*"])
      if (found) return found
    }
    return undefined
  }

  const markCheck = (
    mark: Readonly<Record<string, number>>,
    read: (value: unknown) => unknown,
  ): Check => {
    latest = Math.max(latest, ...Object.values(mark))
    return (value, revision, at) => {
      const name = read(value)
      const since = typeof name === "string" ? mark[name] : undefined
      return typeof since === "number" && since > revision
        ? { at: at.join("."), value: name as string, since }
        : undefined
    }
  }

  // A union told apart by `tag`: its own mark on a variant, and each variant's own marks where
  // the value is of that variant.
  const variantCheck = (
    def: Def,
    tag: string,
    mark: Readonly<Record<string, number>> | undefined,
  ): Check | undefined => {
    const own = mark && markCheck(mark, (value) => record(value)?.[tag])
    const byTag = new Map<unknown, Check>()
    for (const option of optionsOf(def)) {
      const check = make(option)
      const literal = record(defOf(option).shape)?.[tag]
      const values = literal === undefined ? undefined : defOf(literal).values
      if (check && Array.isArray(values)) for (const each of values) byTag.set(each, check)
    }
    if (!own && byTag.size === 0) return undefined
    return (value, revision, at) =>
      own?.(value, revision, at) ?? byTag.get(record(value)?.[tag])?.(value, revision, at)
  }

  const check = make(schema)
  return check && { check, newest: latest }
}

// Each procedure's guard, made once. `null` for one with no marked value.
const guardsMade = new WeakMap<object, Guard | null>()

const guardFor = (procedure: object): Guard | undefined => {
  let guard = guardsMade.get(procedure)
  if (guard === undefined) {
    const schema = inputSchemaOf(procedure)
    guard = (schema === undefined ? undefined : checkerOf(schema)) ?? null
    guardsMade.set(procedure, guard)
  }
  return guard ?? undefined
}

/**
 * How a client reads what a server of another build answers: `reader` gives, for a
 * procedure's path, what to read its answer or each of its stream's items through, or
 * `undefined` to take them as they come; a stream skips an item read as one `skips` names.
 */
export type Outputs = {
  readonly reader: (path: readonly string[]) => ((value: unknown) => unknown) | undefined
  readonly skips: (value: unknown) => boolean
}

const isStream = (value: unknown): value is AsyncIterator<unknown> & AsyncIterable<unknown> =>
  typeof value === "object" && value !== null && Symbol.asyncIterator in value

// `stream` with each item read through `read`, those read as skipped left out; finishing or
// failing it finishes or fails the stream it reads.
const readStream = (
  stream: AsyncIterator<unknown>,
  read: (value: unknown) => unknown,
  skips: (value: unknown) => boolean,
): AsyncIterableIterator<unknown> => ({
  async next() {
    for (;;) {
      // eslint-disable-next-line no-await-in-loop -- Items are read in order.
      const result = await stream.next()
      if (result.done) return result
      const value = read(result.value)
      if (!skips(value)) return { done: false, value }
    }
  },
  return: (value?: unknown) =>
    stream.return ? stream.return(value) : Promise.resolve({ done: true, value }),
  throw: (error?: unknown) => (stream.throw ? stream.throw(error) : Promise.reject(error)),
  [Symbol.asyncIterator]() {
    return this
  },
})

const procedurePaths = (node: unknown, path: readonly string[] = []): string[][] =>
  isProcedure(node)
    ? [[...path]]
    : isNode(node)
      ? Object.entries(node).flatMap(([key, inner]) => procedurePaths(inner, [...path, key]))
      : []

/**
 * `client` as it calls a server of `revision`: a procedure the server is too old to have
 * rejects with `UNSUPPORTED` at once, without asking it, instead of failing there as a call it
 * doesn't know; so does a call whose input holds a value or variant the server predates
 * (`inputEnum`, `inputUnion`), naming the procedure, the place, the value and its revision; and
 * where `outputs` reads a procedure's answers, they come read. When the server has every
 * procedure and value and nothing is read, `client` is returned as it is.
 */
export const gated = <T extends object>(
  client: T,
  contract: unknown,
  revision: number,
  outputs?: Outputs,
): T => {
  const readers = new Map(
    procedurePaths(contract).flatMap((path) => {
      const read = outputs?.reader(path)
      return read ? [[path.join("."), read] as const] : []
    }),
  )
  // Each procedure's marked values are found once, however often a client is gated.
  const guards = new Map(
    procedurePaths(contract).flatMap((path) => {
      const procedure = procedureAt(contract, path)
      const guard = isNode(procedure) ? guardFor(procedure) : undefined
      return guard && guard.newest > revision ? [[path.join("."), guard.check] as const] : []
    }),
  )
  if (newest(contract) <= revision && readers.size === 0 && guards.size === 0) return client
  const skips = outputs?.skips ?? (() => false)
  const wrap = <U extends object>(target: U, node: unknown, path: readonly string[]): U =>
    new Proxy(target, {
      get(inner, key, receiver) {
        const value: unknown = Reflect.get(inner, key, receiver)
        if (typeof key !== "string" || !isNode(node) || isProcedure(node) || !(key in node))
          return value
        const child = node[key]
        const at = [...path, key]
        const since = sinceOf(child)
        if (since !== undefined && since > revision)
          return () =>
            Promise.reject(
              new WireError(
                "UNSUPPORTED",
                `The server, at revision ${revision}, doesn't have ${at.join(".")}, which came in revision ${since}.`,
              ),
            )
        if (isProcedure(child)) {
          const name = at.join(".")
          const read = readers.get(name)
          const guard = guards.get(name)
          if ((!read && !guard) || typeof value !== "function") return value
          return async (...args: unknown[]) => {
            const found = guard?.(args[0], revision, [])
            if (found)
              throw new WireError(
                "UNSUPPORTED",
                `The server, at revision ${revision}, doesn't take ${JSON.stringify(found.value)} at ${found.at === "" ? "the input" : `input ${found.at}`} of ${name}, which came in revision ${found.since}.`,
              )
            const answer: unknown = await (value as (...given: unknown[]) => unknown)(...args)
            return read && isStream(answer)
              ? readStream(answer, read, skips)
              : read
                ? read(answer)
                : answer
          }
        }
        return value === null || (typeof value !== "object" && typeof value !== "function")
          ? value
          : wrap(value as object, child, at)
      },
    })
  return wrap(client, contract, [])
}
