import type { DataRoot } from "./parse.js"

// The tree as rows: which nodes show, from the roots and what's open, each a row the
// viewer draws. Pure, so the viewer only places rows and the rules read on their own.

export type Segment = string | number

/** What a value is, as the tree colours and summarises it. */
export type ValueType = "object" | "array" | "string" | "number" | "boolean" | "null" | "other"

export const typeOf = (value: unknown): ValueType => {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  const type = typeof value
  if (type === "object") return "object"
  if (type === "string" || type === "number" || type === "boolean") return type
  return "other"
}

const isContainer = (type: ValueType): type is "object" | "array" =>
  type === "object" || type === "array"

/** A node's key in the open set: its root and its path, which stay put as the file changes. */
export const keyOf = (root: number, path: readonly Segment[]): string =>
  JSON.stringify([root, ...path])

export type Row = {
  /** The node's key (`keyOf`). */
  readonly key: string
  readonly root: number
  readonly path: readonly Segment[]
  /** How far in it's drawn, from 0. */
  readonly depth: number
  /** What it's called: its key, its index, a root's label, or nothing for a lone root. */
  readonly name: Segment | null
  readonly type: ValueType
  readonly value: unknown
  /** Its children's count, for an object or an array. */
  readonly count?: number
  readonly open: boolean
  /** A record that doesn't read, with why. */
  readonly broken?: string
  /** Where it sits among its siblings, from 1, and how many they are, for assistive tech. */
  readonly position: number
  readonly siblings: number
}

/** Which nodes open by default, before the person opens or closes any. */
export type Opening = {
  /** Whether a root opens: a lone value or a document does, a JSONL record doesn't. */
  readonly roots: boolean
  /** How many levels below a root open, each only if it has no more children than `most`. */
  readonly levels: number
  readonly most: number
}

export const defaultOpening: Opening = { roots: true, levels: 1, most: 100 }

const countOf = (value: unknown, type: ValueType): number =>
  type === "array" ? (value as unknown[]).length : Object.keys(value as object).length

const opensByDefault = (opening: Opening, depth: number, count: number): boolean =>
  depth === 0 ? opening.roots : depth <= opening.levels && count <= opening.most

/**
 * The rows that show: every root, and the children of each open node, depth first. A lone
 * unnamed root that holds things isn't a row: its children are the top rows, as a file
 * that is one object reads as its keys. `open` holds what the person changed from the
 * default, by key.
 */
export const rowsOf = (
  roots: readonly DataRoot[],
  open: ReadonlyMap<string, boolean>,
  opening: Opening = defaultOpening,
): Row[] => {
  const rows: Row[] = []
  const walk = (
    root: number,
    path: readonly Segment[],
    name: Segment | null,
    value: unknown,
    depth: number,
    position: number,
    siblings: number,
  ): void => {
    const type = typeOf(value)
    const key = keyOf(root, path)
    if (!isContainer(type)) {
      rows.push({ key, root, path, depth, name, type, value, open: false, position, siblings })
      return
    }
    const count = countOf(value, type)
    const isOpen = open.get(key) ?? opensByDefault(opening, path.length, count)
    rows.push({
      key,
      root,
      path,
      depth,
      name,
      type,
      value,
      count,
      open: isOpen,
      position,
      siblings,
    })
    if (isOpen) children(root, path, value, type, depth + 1)
  }
  const children = (
    root: number,
    path: readonly Segment[],
    value: unknown,
    type: "object" | "array",
    depth: number,
  ): void => {
    if (type === "array") {
      const items = value as readonly unknown[]
      items.forEach((item, index) =>
        walk(root, [...path, index], index, item, depth, index + 1, items.length),
      )
      return
    }
    const entries = Object.entries(value as Record<string, unknown>)
    entries.forEach(([name, item], index) =>
      walk(root, [...path, name], name, item, depth, index + 1, entries.length),
    )
  }
  const [lone] = roots
  if (roots.length === 1 && lone?.kind === "value" && lone.label === null) {
    const type = typeOf(lone.value)
    // An empty one is its one row, so the file shows it's empty.
    if (isContainer(type) && countOf(lone.value, type) > 0) children(0, [], lone.value, type, 0)
    else walk(0, [], null, lone.value, 0, 1, 1)
    return rows
  }
  roots.forEach((root, index) => {
    if (root.kind === "value")
      return walk(index, [], root.label, root.value, 0, index + 1, roots.length)
    rows.push({
      key: keyOf(index, []),
      root: index,
      path: [],
      depth: 0,
      name: root.label,
      type: "string",
      value: root.text,
      open: false,
      broken: root.reason,
      position: index + 1,
      siblings: roots.length,
    })
  })
  return rows
}

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/

/** A node's path as jq writes it: `.items[0].name`, `.["a key"]`; `.` for the root. */
export const pathText = (path: readonly Segment[]): string => {
  if (path.length === 0) return "."
  return path
    .map((segment, index) => {
      if (typeof segment === "number") return index === 0 ? `.[${segment}]` : `[${segment}]`
      if (identifier.test(segment)) return `.${segment}`
      return index === 0 ? `.[${JSON.stringify(segment)}]` : `[${JSON.stringify(segment)}]`
    })
    .join("")
}

/** A value as it's copied: a string's own text, anything else as JSON, indented. */
export const copyText = (value: unknown): string => {
  if (typeof value === "string") return value
  if (typeof value === "number" && !Number.isFinite(value)) return String(value)
  // A YAML alias inside its own anchor holds itself: it copies as "[Circular]" there.
  const within: object[] = []
  const replacer = function (this: unknown, _key: string, item: unknown): unknown {
    while (within.length > 0 && within.at(-1) !== this) within.pop()
    if (typeof item !== "object" || item === null) return item
    if (within.includes(item)) return "[Circular]"
    within.push(item)
    return item
  }
  return JSON.stringify(value, replacer, 2) ?? String(value)
}

/** A plain value as one line: a string in quotes with its breaks escaped, cut at `most`. */
export const scalarText = (value: unknown, most = 400): string => {
  const text =
    typeof value === "string"
      ? JSON.stringify(value.length > most ? value.slice(0, most) : value)
      : String(value)
  return typeof value === "string" && value.length > most ? `${text.slice(0, -1)}…"` : text
}

/** How many an object or array holds, in words: "3 keys", "1 item". */
export const countText = (type: "object" | "array", count: number): string =>
  type === "array"
    ? `${count} ${count === 1 ? "item" : "items"}`
    : `${count} ${count === 1 ? "key" : "keys"}`

/**
 * A closed object or array at a glance, as a browser's console shows one: its first
 * entries, nested ones as `{…}` and `[…]`, up to about `budget` characters.
 */
export const previewText = (value: unknown, budget = 120): string => {
  const type = typeOf(value)
  if (!isContainer(type)) return scalarText(value, budget)
  const nested = (item: unknown): string => {
    const kind = typeOf(item)
    if (kind === "object") return Object.keys(item as object).length === 0 ? "{}" : "{…}"
    if (kind === "array") return (item as unknown[]).length === 0 ? "[]" : "[…]"
    return scalarText(item, 40)
  }
  const parts =
    type === "array"
      ? (value as unknown[]).map(nested)
      : Object.entries(value as Record<string, unknown>).map(
          ([key, item]) => `${identifier.test(key) ? key : JSON.stringify(key)}: ${nested(item)}`,
        )
  const [open, close] = type === "array" ? ["[", "]"] : ["{", "}"]
  let text = ""
  for (const [index, part] of parts.entries()) {
    const next = text === "" ? part : `${text}, ${part}`
    if (next.length > budget) return `${open}${text === "" ? "" : `${text}, `}…${close}`
    text = next
    if (index === parts.length - 1) break
  }
  return `${open}${text}${close}`
}
