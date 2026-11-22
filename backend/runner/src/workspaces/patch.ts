import type { SessionPatch } from "@novadeck/protocol"

import { DomainError } from "../errors.js"

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value)

// Puts `value` at `key` as the object's own, whatever the key: never a prototype it meets.
const put = (target: Json, key: string, value: unknown): void => {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  })
}

const refused = (why: string): DomainError => new DomainError("CONFLICT", why)

/**
 * `state`, a session's client state as JSON (null before its first save, as an empty object),
 * with `patch` applied: each `unset` path taken out, then each `set` path given its value
 * whole, any objects on the way there made. A state that isn't a JSON object, a path through
 * something that isn't one, or a result past `maxLength` is a `CONFLICT`. What the state means
 * is the client's: nothing here reads it.
 */
export const patched = (state: string | null, patch: SessionPatch, maxLength: number): string => {
  let root: unknown = {}
  if (state !== null) {
    try {
      root = JSON.parse(state)
    } catch {
      throw refused("The session's state isn't JSON, so it can't be changed in part")
    }
  }
  if (!isObject(root)) throw refused("The session's state isn't a JSON object")
  const holder = (path: readonly string[], make: boolean): Json | undefined => {
    let node: Json = root as Json
    for (const key of path.slice(0, -1)) {
      const inner = Object.hasOwn(node, key) ? node[key] : undefined
      if (inner === undefined && make) {
        const made: Json = {}
        put(node, key, made)
        node = made
        continue
      }
      if (inner === undefined) return undefined
      if (!isObject(inner)) throw refused(`The state holds no object at ${path.join(".")}`)
      node = inner
    }
    return node
  }
  for (const path of patch.unset) {
    const node = holder(path, false)
    if (node) delete node[path.at(-1)!]
  }
  for (const { path, value } of patch.set) put(holder(path, true)!, path.at(-1)!, value)
  const text = JSON.stringify(root)
  if (text.length > maxLength) throw refused("The session's state would be too large")
  return text
}
