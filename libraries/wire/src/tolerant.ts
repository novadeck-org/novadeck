import { ContractProcedure, type AnyContractRouter, type AnySchema } from "@orpc/contract"

import { validateTolerantly } from "./read.js"

/** Told of the keys an input had that its schema doesn't name, by the procedure's path. */
export type Dropped = (procedure: readonly string[], keys: readonly string[]) => void

type Definition = ContractProcedure<AnySchema, AnySchema, never, never>["~orpc"]

// A procedure by its shape, as oRPC tells one, not by class: a second copy of oRPC's
// contract package would make a class check miss every procedure, and drop nothing.
const definitionOf = (node: unknown): Definition | undefined => {
  const def = (node as { readonly "~orpc"?: unknown } | null | undefined)?.["~orpc"]
  return typeof def === "object" && def !== null && "errorMap" in def
    ? (def as Definition)
    : undefined
}

const tolerate = (schema: AnySchema, told: (keys: readonly string[]) => void): AnySchema => ({
  "~standard": {
    ...schema["~standard"],
    validate: (value: unknown) => validateTolerantly(schema, value, told) as never,
  },
})

/**
 * `contract` with each procedure's input taking keys it doesn't name and dropping them, for a
 * server that serves clients newer than itself: a field one added that this server doesn't
 * know is left out before its handler runs, never passed on. Every key the schema names, in
 * any of a union's options, is checked as strictly as before; an input with anything else
 * wrong is refused as it was, unknown keys and all. Parsing costs nothing more for an input
 * with no unknown keys. Only the schemas the server validates inputs with change: the
 * contract's own, which other code may parse with, stay strict.
 */
export const dropUnknownKeys = <C extends AnyContractRouter>(
  contract: C,
  dropped: Dropped = () => {},
): C => {
  const walk = (node: unknown, path: readonly string[]): unknown => {
    const def = definitionOf(node)
    if (def !== undefined) {
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
