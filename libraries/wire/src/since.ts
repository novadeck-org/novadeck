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

/**
 * `client` as it calls a server of `revision`: a procedure the server is too old to have
 * rejects with `UNSUPPORTED` at once, without asking it, instead of failing there as a call it
 * doesn't know. When the server has every procedure, `client` is returned as it is.
 */
export const gated = <T extends object>(client: T, contract: unknown, revision: number): T => {
  if (newest(contract) <= revision) return client
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
        return isProcedure(child) ||
          value === null ||
          (typeof value !== "object" && typeof value !== "function")
          ? value
          : wrap(value as object, child, at)
      },
    })
  return wrap(client, contract, [])
}
