import type { SessionPatch } from "@novadeck/protocol"

// A session's saved state (state.ts) is changed and merged a record at a time, never a field:
// a terminal's canvas geometry, its hidden mark, its Grid span or its bar, each whole; and
// whole otherwise (the order, the view, anything a newer build added). Two clients that change
// different records both keep their change; two that change one record keep the later one
// whole, never a mix of both, which neither wrote and the views might not take.

type Json = Record<string, unknown>
type Path = readonly string[]

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// The maps whose entries are records of their own, each a terminal's (or a window's) by id.
const recordMaps: readonly Path[] = [
  ["state", "layout", "canvas", "geometry"],
  ["state", "layout", "hidden"],
  ["state", "layout", "spans"],
  ["state", "bars"],
]

const isPrefix = (prefix: Path, path: Path): boolean =>
  prefix.length <= path.length && prefix.every((key, index) => path[index] === key)

// The records of `value`, by their paths: each record map's entries, and every other leaf of
// the state whole at the deepest object key that holds no record map.
const recordsOf = (value: unknown): Map<string, { path: Path; value: unknown }> => {
  const records = new Map<string, { path: Path; value: unknown }>()
  const walk = (node: unknown, path: Path): void => {
    const map = recordMaps.find((each) => each.length === path.length && isPrefix(each, path))
    if (map && isObject(node)) {
      for (const [key, inner] of Object.entries(node))
        records.set(JSON.stringify([...path, key]), { path: [...path, key], value: inner })
      return
    }
    // Deeper only where a record map is below: what isn't one is a record whole.
    if (
      isObject(node) &&
      recordMaps.some((each) => each.length > path.length && isPrefix(path, each))
    ) {
      for (const [key, inner] of Object.entries(node)) walk(inner, [...path, key])
      return
    }
    if (path.length > 0) records.set(JSON.stringify(path), { path, value: node })
  }
  walk(value, [])
  return records
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

// What `value` holds at `path`, if every step on the way is an object.
const valueAt = (value: unknown, path: Path): unknown => {
  let node = value
  for (const key of path) {
    if (!isObject(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

/** Whether a patch changes nothing. */
export const emptyPatch = (patch: SessionPatch): boolean =>
  patch.set.length === 0 && patch.unset.length === 0

/**
 * What changes `from` into `to`, a record at a time (see above): each record `to` has that
 * differs from `from`'s, whole, and each one `from` has that `to` doesn't, taken out. Both
 * are a session's saved state as JSON.
 */
export const diffPatch = (from: unknown, to: unknown): SessionPatch => {
  const before = recordsOf(from)
  const after = recordsOf(to)
  // A record map one side lacks goes whole, as one record: so an empty one is sent too, and
  // one taken out goes at once.
  const whole = recordMaps.filter(
    (path) => isObject(valueAt(from, path)) !== isObject(valueAt(to, path)),
  )
  const within = (path: Path): boolean => whole.some((map) => isPrefix(map, path))
  return {
    set: [
      ...whole
        .filter((path) => isObject(valueAt(to, path)))
        .map((path) => ({ path: [...path], value: valueAt(to, path) as never })),
      ...[...after]
        .filter(
          ([key, { path, value }]) =>
            !within(path) && (!before.has(key) || !same(before.get(key)!.value, value)),
        )
        .map(([, { path, value }]) => ({ path: [...path], value: value as never })),
    ],
    unset: [
      ...whole.filter((path) => isObject(valueAt(from, path))).map((path) => [...path]),
      ...[...before]
        .filter(([key, { path }]) => !within(path) && !after.has(key))
        .map(([, { path }]) => [...path]),
    ],
  }
}

// Puts `value` at `key` as the object's own, whatever the key.
const put = (target: Json, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

/**
 * `value` (a copy) with `patch` applied as the runner applies it: each `unset` path taken out,
 * then each `set` path given its value whole, objects made on the way; a path through
 * something that isn't an object is left as it was.
 */
export const applyPatch = (value: unknown, patch: SessionPatch): unknown => {
  const root: unknown = structuredClone(value ?? {})
  if (!isObject(root)) return root
  const holder = (path: Path, make: boolean): Json | undefined => {
    let node: Json = root
    for (const key of path.slice(0, -1)) {
      const inner = Object.hasOwn(node, key) ? node[key] : undefined
      if (inner === undefined && make) {
        const made: Json = {}
        put(node, key, made)
        node = made
      } else if (isObject(inner)) node = inner
      else return undefined
    }
    return node
  }
  for (const path of patch.unset) {
    const node = holder(path, false)
    if (node) delete node[path.at(-1)!]
  }
  for (const { path, value: given } of patch.set) {
    const node = holder(path, true)
    if (node) put(node, path.at(-1)!, structuredClone(given))
  }
  return root
}

/**
 * `value` (a copy) with the records `patch` names put back as `from` has them: each set to
 * `from`'s value there, or taken out where `from` has none.
 */
export const restored = (value: unknown, from: unknown, patch: SessionPatch): unknown => {
  const paths = [...patch.set.map(({ path }) => path), ...patch.unset]
  return applyPatch(value, {
    set: paths
      .filter((path) => valueAt(from, path) !== undefined)
      .map((path) => ({ path: [...path], value: valueAt(from, path) as never })),
    unset: paths.filter((path) => valueAt(from, path) === undefined).map((path) => [...path]),
  })
}

// What the contract takes of a patch: at most 2048 of each, paths of 1 to 8 keys, each 1 to
// 256 characters and never `__proto__`.
const fitsPath = (path: Path): boolean =>
  path.length >= 1 &&
  path.length <= 8 &&
  path.every((key) => key.length >= 1 && key.length <= 256 && key !== "__proto__")

/** Whether the runner takes `patch` (a state it can't name a record of goes whole instead). */
export const fitsContract = (patch: SessionPatch): boolean =>
  patch.set.length <= 2048 &&
  patch.unset.length <= 2048 &&
  patch.set.every(({ path }) => fitsPath(path)) &&
  patch.unset.every(fitsPath)

const parsed = (text: string | null | undefined): unknown => {
  if (text === null || text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/**
 * A session's state as this client should hold it once another client's change arrives: what
 * arrived (`incoming`), with this client's own changes not yet there (what changed from
 * `remote`, the state it last knew the runner held, to `local`, its own) laid over it. Its own
 * change that already arrived lays over itself, so an echo changes nothing; another's change
 * folded into a later one of its own is kept, as it is in what arrived. All three are saved
 * states as text; undefined where `incoming` can't be read.
 */
export const rebased = (
  remote: string | null | undefined,
  local: string,
  incoming: string | null,
): string | undefined => {
  const arrived = parsed(incoming)
  if (arrived === undefined) return undefined
  const unsent = diffPatch(parsed(remote) ?? {}, parsed(local))
  return JSON.stringify(applyPatch(arrived, unsent))
}
