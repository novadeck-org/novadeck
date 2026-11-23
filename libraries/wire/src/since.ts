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
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined } | null)?.meta?.()
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

const lazyOf = (def: Def): unknown => (def.getter as () => unknown)()

// The schemas `schema` is, as a value meets it: itself, what a wrapper, a pipe or a lazy schema
// holds, and every option of a union and part of an intersection, each with its own marks.
const viewsOf = (schema: unknown, seen = new Set<unknown>()): unknown[] => {
  if (seen.has(schema)) return []
  seen.add(schema)
  const def = defOf(schema)
  const inner: readonly unknown[] =
    def.type === "pipe"
      ? [def.in]
      : def.type === "lazy"
        ? [lazyOf(def)]
        : def.type === "intersection"
          ? [def.left, def.right]
          : wrappers.has(def.type)
            ? [def.innerType]
            : optionsOf(def)
  return [schema, ...inner.flatMap((each) => viewsOf(each, seen))]
}

// What `key` holds in `schema`: an object's key; `*` for a list's or tuple's items, a record's
// values and keys, and an object's keys its shape doesn't name (its catchall).
const reach = (schema: unknown, key: string): unknown[] =>
  viewsOf(schema)
    .flatMap((view) => {
      const def = defOf(view)
      switch (def.type) {
        case "array":
          return key === "*" ? [def.element] : []
        case "tuple":
          return key === "*" ? [...((def.items as unknown[]) ?? []), def.rest] : []
        case "record":
          return key === "*" ? [def.valueType, def.keyType] : []
        case "object": {
          const named = isNode(def.shape) ? def.shape[key] : undefined
          // A strict object's catchall is `never`, which takes no key.
          return named === undefined && defOf(def.catchall).type !== "never"
            ? [def.catchall]
            : [named]
        }
        default:
          return []
      }
    })
    .filter((each) => each != null)

const inputSchemaOf = (procedure: unknown): unknown =>
  (procedure as { readonly "~orpc": { readonly inputSchema?: unknown } })["~orpc"].inputSchema

/**
 * Whether a server of `revision` takes `value` at `at` of the input of the procedure at `path`:
 * not one an input enum or union marks as new since a later revision (`inputEnum`,
 * `inputUnion`), in any of the places `at` reaches. `at` names keys of the input with `.`
 * between them, `*` for a list's or tuple's items and a record's values and keys (or the
 * keys an object's catchall takes): `"harness"`, `"options.harnesses.*"`. It is the `at` a
 * gated line of the compatibility check prints. For a union, `value` is the variant's tag
 * value. A value with no mark is taken; a procedure the contract lacks, or an `at` the input
 * doesn't have, isn't, so a mistyped place fails closed.
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
  let nodes: unknown[] = [inputSchemaOf(procedure)].filter((each) => each !== undefined)
  for (const key of at === "" ? [] : at.split("."))
    nodes = nodes.flatMap((node) => reach(node, key))
  if (nodes.length === 0) return false
  return nodes
    .flatMap((node) => viewsOf(node))
    .every((view) => {
      const since = marksOf(view)?.[value]
      return typeof since !== "number" || since <= revision
    })
}

type Violation = { readonly at: string; readonly value: string; readonly since: number }
type Check = (value: unknown, revision: number, at: readonly string[]) => Violation | undefined
// A check, with the newest revision any value it looks for came in.
type Guard = { readonly check: Check; readonly newest: number }

const record = (value: unknown): Record<string, unknown> | undefined =>
  isNode(value) && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined

// The values a schema's `tag` key takes: a literal's or an enum's, through a nested union's
// options.
const tagsOf = (option: unknown, tag: string): readonly unknown[] => {
  const def = defOf(option)
  if (def.type === "union") return optionsOf(def).flatMap((each) => tagsOf(each, tag))
  const field = record(def.shape)?.[tag]
  if (field === undefined) return []
  const tagDef = defOf(field)
  if (tagDef.type === "enum") return Object.values(record(tagDef.entries) ?? {})
  return Array.isArray(tagDef.values) ? tagDef.values : []
}

const firstOf = (checks: readonly Check[]): Check | undefined =>
  checks.length === 0
    ? undefined
    : (value, revision, at) => {
        for (const check of checks) {
          const found = check(value, revision, at)
          if (found) return found
        }
        return undefined
      }

// How to find, in an input of `schema`, a value marked new since a revision later than a
// server's; `undefined` when the schema marks none. Every schema is walked once, so one that
// meets itself again, by a getter or a lazy schema, ends there.
const checkerOf = (schema: unknown): Guard | undefined => {
  let latest = 0
  const made = new Map<unknown, { check: Check | undefined }>()

  const make = (node: unknown): Check | undefined => {
    const known = made.get(node)
    if (known) return (value, revision, at) => known.check?.(value, revision, at)
    const slot: { check: Check | undefined } = { check: undefined }
    made.set(node, slot)
    slot.check = build(node)
    return slot.check
  }

  const items = (nodes: readonly unknown[]): Check | undefined => {
    const checks = nodes.flatMap((node) => {
      const check = make(node)
      return check ? [check] : []
    })
    const each = firstOf(checks)
    return (
      each &&
      ((value, revision, at) => {
        const given = Array.isArray(value)
          ? value
          : (record(value) && Object.values(record(value)!)) || []
        for (const item of given) {
          const found = each(item, revision, [...at, "*"])
          if (found) return found
        }
        return undefined
      })
    )
  }

  const build = (node: unknown): Check | undefined => {
    const def = defOf(node)
    const mark = marksOf(node)
    const tag =
      def.type === "union" && typeof def.discriminator === "string" ? def.discriminator : undefined
    const own =
      mark &&
      markCheck(mark, tag === undefined ? (value) => value : (value) => record(value)?.[tag])
    const checks: Check[] = own ? [own] : []
    const add = (check: Check | undefined) => {
      if (check) checks.push(check)
    }
    if (wrappers.has(def.type)) {
      const inner = make(def.innerType)
      add(
        inner &&
          ((value, revision, at) => (value == null ? undefined : inner(value, revision, at))),
      )
    } else if (def.type === "pipe") add(make(def.in))
    else if (def.type === "lazy") add(make(lazyOf(def)))
    else if (def.type === "intersection")
      add(firstOf([def.left, def.right].flatMap((each) => make(each) ?? [])))
    else if (def.type === "object") {
      const fields = Object.entries(record(def.shape) ?? {}).flatMap(([key, field]) => {
        const check = make(field)
        return check ? [[key, check] as const] : []
      })
      const rest = def.catchall === undefined ? undefined : make(def.catchall)
      if (fields.length > 0 || rest)
        add((value, revision, at) => {
          const given = record(value)
          if (!given) return undefined
          for (const [key, each] of Object.entries(given)) {
            const field = fields.find(([name]) => name === key)
            const check = field ? field[1] : rest
            const found = check?.(each, revision, [...at, field ? key : "*"])
            if (found) return found
          }
          return undefined
        })
    } else if (def.type === "array") add(items([def.element]))
    else if (def.type === "tuple")
      add(items([...((def.items as unknown[]) ?? []), def.rest].filter((each) => each != null)))
    else if (def.type === "record") {
      // A record's keys are checked as its values are, each at `*`.
      const key = make(def.keyType)
      add(
        key &&
          ((value, revision, at) => {
            for (const name of Object.keys(record(value) ?? {})) {
              const found = key(name, revision, [...at, "*"])
              if (found) return found
            }
            return undefined
          }),
      )
      add(items([def.valueType]))
    } else if (tag !== undefined) {
      // A union told apart by `tag`: each option's marks, where the value is of that option.
      const byTag = new Map<unknown, Check[]>()
      for (const option of optionsOf(def)) {
        const check = make(option)
        if (check)
          for (const each of tagsOf(option, tag))
            byTag.set(each, [...(byTag.get(each) ?? []), check])
      }
      if (byTag.size > 0)
        add((value, revision, at) =>
          firstOf(byTag.get(record(value)?.[tag]) ?? [])?.(value, revision, at),
        )
    } else if (def.type === "union")
      add(firstOf(optionsOf(def).flatMap((each) => make(each) ?? [])))
    return firstOf(checks)
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
