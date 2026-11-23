import { z } from "zod"

/**
 * What a UI meets in place of a value or variant a newer runner sent that it doesn't know,
 * where it keeps the element and says it needs a newer Novadeck. A runner never sends it.
 */
export const newer = "newer"

/** The keyword an open schema carries, in zod's meta and in contract.json. */
export const openMark = "x-open"

/**
 * What a reader does with a value it doesn't know: drop the list element or stream item that
 * holds it, as for an annotation nobody waits on; read it as a catch-all the schema already
 * has; or keep it as `newer`, for what someone waits on or sees.
 */
export type Unknown = "drop" | "placeholder" | { readonly fallback: string }

/** An open schema's mark: since which revision UIs read it so, and how. */
export type Open = { readonly since: number; readonly unknown: Unknown }

/**
 * `values` as an output's enum a UI reads tolerantly from revision `since`. A placeholder
 * takes `newer` too, which only the reader writes; the others are the enum as it is.
 */
export function openEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  open: { readonly since: number; readonly unknown: "placeholder" },
): z.ZodEnum<{ [K in T[number] | typeof newer]: K }>
export function openEnum<const T extends readonly [string, ...string[]]>(
  values: T,
  open: { readonly since: number; readonly unknown: "drop" | { readonly fallback: T[number] } },
): z.ZodEnum<{ [K in T[number]]: K }>
export function openEnum(values: readonly [string, ...string[]], open: Open): z.ZodType {
  const all = open.unknown === "placeholder" ? [...values, newer] : [...values]
  return z.enum(all as [string, ...string[]]).meta({ [openMark]: open })
}

/**
 * A discriminated union of an output a UI reads tolerantly from revision `since`: a variant
 * whose `tag` it doesn't know is dropped with the element that holds it, or kept as the
 * placeholder variant, `{ [tag]: "newer" }`, which only the reader writes.
 */
type Options = readonly [z.core.$ZodTypeDiscriminable, ...z.core.$ZodTypeDiscriminable[]]
type Placeholder<Tag extends string> = z.ZodObject<
  { [K in Tag]: z.ZodLiteral<typeof newer> },
  z.core.$strict
>

export function openUnion<const Tag extends string, const T extends Options>(
  tag: Tag,
  options: T,
  open: { readonly since: number; readonly unknown: "placeholder" },
): z.ZodDiscriminatedUnion<[...T, Placeholder<Tag>], Tag>
export function openUnion<const Tag extends string, const T extends Options>(
  tag: Tag,
  options: T,
  open: { readonly since: number; readonly unknown: "drop" },
): z.ZodDiscriminatedUnion<[...T], Tag>
export function openUnion(
  tag: string,
  options: Options,
  open: { readonly since: number; readonly unknown: "drop" | "placeholder" },
): z.ZodType {
  const placeholder = z.strictObject({ [tag]: z.literal(newer) })
  return open.unknown === "placeholder"
    ? z.discriminatedUnion(tag, [...options, placeholder]).meta({ [openMark]: open })
    : z.discriminatedUnion(tag, [...options]).meta({ [openMark]: open })
}

/** The keyword an input's marked values carry, in zod's meta and in contract.json. */
export const sinceMark = "x-since"

/** Each new value of an input enum, or each new variant's tag value, by the revision it came in. */
export type ValueSince<Value extends string = string> = { readonly [K in Value]?: number }

/**
 * `values` as an input's enum, where the values a release lacked say the revision they came in:
 * a runner older than it doesn't know the value, so a client sends it only to one at that
 * revision or later (`servesValue`, `gated` in `@novadeck/wire`), and the compatibility check
 * takes it as additive. Values a release already had carry none. It is the plain enum.
 */
export const inputEnum = <const T extends readonly [string, ...string[]]>(
  values: T,
  input: { readonly since: ValueSince<T[number]> },
): z.ZodEnum<{ [K in T[number]]: K }> => z.enum(values).meta({ [sinceMark]: input.since }) as never

/**
 * A discriminated union of an input, where a variant a release lacked says the revision it came
 * in by its `tag` value, as `inputEnum` does for a value. It is the plain union.
 */
export const inputUnion = <const Tag extends string, const T extends Options>(
  tag: Tag,
  options: T,
  input: { readonly since: ValueSince },
): z.ZodDiscriminatedUnion<[...T], Tag> =>
  z.discriminatedUnion(tag, [...options]).meta({ [sinceMark]: input.since }) as never

// A placeholder variant: an object whose every key reads `newer`.
type IsPlaceholder<T> = keyof T extends never
  ? false
  : T extends { readonly [K in keyof T]: typeof newer }
    ? true
    : false

/**
 * An output's type as a runner holds and sends it, without the placeholders only a UI's
 * reader writes: the runner's own records are typed so.
 */
export type Sent<T> = T extends typeof newer
  ? never
  : T extends (infer U)[]
    ? Sent<U>[]
    : T extends readonly (infer U)[]
      ? readonly Sent<U>[]
      : T extends object
        ? IsPlaceholder<T> extends true
          ? never
          : { [K in keyof T]: Sent<T[K]> }
        : T

// What a reader returns for a value it drops, which its list or stream leaves out.
const dropped: unique symbol = Symbol("dropped")
type Read = (value: unknown) => unknown

type Def = { readonly type: string; readonly [key: string]: unknown }
const defOf = (schema: unknown): Def => (schema as { readonly def: Def }).def

const markOf = (schema: unknown): Open | undefined => {
  const meta = (schema as { meta?: () => Record<string, unknown> | undefined }).meta?.()
  return meta?.[openMark] as Open | undefined
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

// The literal values a union's option is told by, under `tag`.
const tagsOf = (option: unknown, tag: string): readonly unknown[] => {
  const shape = record(defOf(option).shape)
  const literal = shape?.[tag]
  const values = literal === undefined ? undefined : defOf(literal).values
  return Array.isArray(values) ? values : []
}

// `list` read item by item, the same list where nothing changed, a copy without the items read
// as dropped and with those read anew otherwise.
const readList = (list: readonly unknown[], item: Read): readonly unknown[] => {
  let copy: unknown[] | undefined
  list.forEach((each, index) => {
    const read = item(each)
    if (read === each && copy === undefined) return
    copy ??= list.slice(0, index)
    if (read !== dropped) copy.push(read)
  })
  return copy ?? list
}

/**
 * How a UI reads a value of `schema` a runner sent: where the schema has open parts, the
 * values and variants it doesn't know become what each part says. `undefined` when it has
 * none, for a value read as it is, at no cost. A list leaves out an element read as dropped,
 * and a dropped value with no list to leave it is a stream item its reader skips
 * (`isDropped`).
 */
export const readerOf = (schema: unknown): Read | undefined => {
  // Lazy schemas read through the reader being made for them, so a recursive one ends. A
  // recursive schema is walked whether or not it has open parts (the contract has none).
  const making = new Map<unknown, { read: Read | undefined }>()

  const make = (node: unknown): Read | undefined => {
    const pending = making.get(node)
    if (pending) return (value) => (pending.read ? pending.read(value) : value)
    const def = defOf(node)
    const mark = markOf(node)
    if (mark) return openRead(node, def, mark)
    switch (def.type) {
      case "optional":
      case "nullable":
      case "default":
      case "prefault":
      case "readonly":
      case "catch":
      case "nonoptional": {
        const inner = make(def.innerType)
        return inner && ((value) => (value === undefined || value === null ? value : inner(value)))
      }
      case "pipe":
        return make(def.out)
      case "lazy": {
        const slot: { read: Read | undefined } = { read: undefined }
        making.set(node, slot)
        slot.read = make((def.getter as () => unknown)())
        return slot.read
      }
      case "object":
        return objectRead(record(def.shape) ?? {})
      case "array": {
        const item = make(def.element)
        return item && ((value) => (Array.isArray(value) ? readList(value, item) : value))
      }
      case "record": {
        const item = make(def.valueType)
        return (
          item &&
          ((value) => {
            const given = record(value)
            if (!given) return value
            let copy: Record<string, unknown> | undefined
            for (const [key, each] of Object.entries(given)) {
              const read = item(each)
              if (read === each) continue
              copy ??= { ...given }
              if (read === dropped) delete copy[key]
              else copy[key] = read
            }
            return copy ?? given
          })
        )
      }
      case "union":
        return unionRead(def)
      default:
        return undefined
    }
  }

  const objectRead = (shape: Record<string, unknown>): Read | undefined => {
    const fields = Object.entries(shape).flatMap(([key, field]) => {
      const read = make(field)
      return read ? [[key, read] as const] : []
    })
    if (fields.length === 0) return undefined
    return (value) => {
      const given = record(value)
      if (!given) return value
      let copy: Record<string, unknown> | undefined
      for (const [key, read] of fields) {
        if (!(key in given)) continue
        const each = read(given[key])
        if (each === dropped) return dropped
        if (each !== given[key]) (copy ??= { ...given })[key] = each
      }
      return copy ?? given
    }
  }

  const unionRead = (def: Def): Read | undefined => {
    const options = (def.options as readonly unknown[] | undefined) ?? []
    const tag = def.discriminator
    if (typeof tag !== "string") {
      // A plain union: only one whose other options are null holds open parts, read alike.
      const parts = options.flatMap((option) => {
        const read = make(option)
        return read ? [read] : []
      })
      if (parts.length === 0) return undefined
      if (
        parts.length > 1 ||
        options.some((option) => !make(option) && defOf(option).type !== "null")
      )
        throw new Error(
          "An open schema inside a plain union can't be told apart: use a discriminated one.",
        )
      return parts[0]
    }
    const byTag = new Map<unknown, Read>()
    for (const option of options) {
      const read = make(option)
      if (read) for (const value of tagsOf(option, tag)) byTag.set(value, read)
    }
    if (byTag.size === 0) return undefined
    return (value) => {
      const read = byTag.get(record(value)?.[tag])
      return read ? read(value) : value
    }
  }

  const openRead = (node: unknown, def: Def, mark: Open): Read => {
    const unknown = (value: unknown): unknown =>
      mark.unknown === "drop"
        ? dropped
        : mark.unknown === "placeholder"
          ? value
          : mark.unknown.fallback
    if (def.type === "enum") {
      const known = new Set(Object.values(record(def.entries) ?? {}))
      known.delete(newer)
      return (value) =>
        known.has(value) ? value : mark.unknown === "placeholder" ? newer : unknown(value)
    }
    if (def.type === "union" && typeof def.discriminator === "string") {
      const tag = def.discriminator
      const inner = unionRead(def)
      const known = new Set(
        ((def.options as readonly unknown[] | undefined) ?? []).flatMap((option) =>
          tagsOf(option, tag),
        ),
      )
      known.delete(newer)
      return (value) => {
        if (known.has(record(value)?.[tag])) return inner ? inner(value) : value
        return mark.unknown === "placeholder" ? { [tag]: newer } : unknown(value)
      }
    }
    throw new Error(`An open mark belongs on an enum or a discriminated union, not a ${def.type}.`)
  }

  return make(schema)
}

/** Whether a reader dropped what it read: a stream skips such an item. */
export const isDropped = (value: unknown): boolean => value === dropped
