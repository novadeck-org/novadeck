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
 * doesn't know; and where `outputs` reads a procedure's answers, they come read. When the
 * server has every procedure and nothing is read, `client` is returned as it is.
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
  if (newest(contract) <= revision && readers.size === 0) return client
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
          const read = readers.get(at.join("."))
          if (!read || typeof value !== "function") return value
          return async (...args: unknown[]) => {
            const answer: unknown = await (value as (...given: unknown[]) => unknown)(...args)
            return isStream(answer) ? readStream(answer, read, skips) : read(answer)
          }
        }
        return value === null || (typeof value !== "object" && typeof value !== "function")
          ? value
          : wrap(value as object, child, at)
      },
    })
  return wrap(client, contract, [])
}
