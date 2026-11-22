import { getEventIteratorSchemaDetails, type AnyContractRouter } from "@orpc/contract"
import { z } from "zod"

import type { Compatibility } from "./compatibility.js"

/** A JSON Schema as zod writes one, with the two marks below. */
export type JsonSchema = { readonly [keyword: string]: unknown }

/** One procedure of a contract, as `contract.json` keeps it. */
export type ProcedureSnapshot = {
  /** The revision that added it, when a UI must check a runner has it (`since` in its meta). */
  readonly since?: number
  readonly input: JsonSchema
  /** What a call answers, or, for a stream, the items it yields. */
  readonly output?: JsonSchema
  readonly yields?: JsonSchema
}

/**
 * A contract as a release has it: its window, every procedure's schemas by path, and every
 * error's data, which the UI reads as it reads an answer.
 */
export type ContractSnapshot = Compatibility & {
  readonly errors: { readonly [code: string]: JsonSchema | null }
  readonly procedures: { readonly [path: string]: ProcedureSnapshot }
}

/**
 * Marks a schema whose root takes `undefined`, which JSON Schema can't say: a procedure with
 * no input, an optional one, or error data that may be left out.
 */
export const optionalMark = "x-optional"
/** Marks what JSON Schema can't hold (a date, a transform's result), by zod's name for it. */
export const unrepresentableMark = "x-zod"

const unrepresentable = new Set([
  "bigint",
  "custom",
  "date",
  "function",
  "map",
  "nan",
  "promise",
  "set",
  "symbol",
  "transform",
])

// Only zod's sync schemas are in the contract.
const takesUndefined = (schema: z.ZodType): boolean => schema.safeParse(undefined).success

// The pattern zod writes beside a format repeats the format at length, so only the format
// stays. Every key of zod's output stays in the order zod writes it.
const tidy = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(tidy)
  if (typeof value !== "object" || value === null) return value
  const entries = Object.entries(value).filter(
    ([key]) => key !== "$schema" && !(key === "pattern" && "format" in value),
  )
  return Object.fromEntries(entries.map(([key, inner]) => [key, tidy(inner)]))
}

const toJson = (schema: unknown, io: "input" | "output"): JsonSchema => {
  if (!(schema instanceof z.ZodType)) return { [unrepresentableMark]: "not zod" }
  const written = z.toJSONSchema(schema, {
    io,
    unrepresentable: "any",
    override: ({ zodSchema, jsonSchema }) => {
      const { type } = (zodSchema as unknown as z.ZodType).def
      // A pipe's output is its last stage's, which zod writes; a transform alone is opaque.
      if (unrepresentable.has(type)) jsonSchema[unrepresentableMark] = type
    },
  })
  const tidied = tidy(written) as JsonSchema
  return takesUndefined(schema) ? { [optionalMark]: true, ...tidied } : tidied
}

type Procedure = {
  readonly "~orpc": {
    readonly inputSchema?: unknown
    readonly outputSchema?: unknown
    readonly errorMap: { readonly [code: string]: { readonly data?: unknown } | undefined }
    readonly meta: { readonly since?: unknown }
  }
}

const isProcedure = (node: unknown): node is Procedure =>
  typeof node === "object" && node !== null && "~orpc" in node

const describe = (procedure: Procedure): ProcedureSnapshot => {
  const { inputSchema, outputSchema, meta } = procedure["~orpc"]
  const since = typeof meta.since === "number" ? { since: meta.since } : {}
  // No input schema takes anything, as oRPC passes it through unread.
  const input = inputSchema === undefined ? {} : toJson(inputSchema, "input")
  const stream = getEventIteratorSchemaDetails(outputSchema as never)
  if (stream) return { ...since, input, yields: toJson(stream.yields, "output") }
  return {
    ...since,
    input,
    output: outputSchema === undefined ? {} : toJson(outputSchema, "output"),
  }
}

/**
 * `contract`'s shape as `contract.json` keeps it: each procedure by its dotted path, in the
 * contract's order, and the data of each error code any of them names.
 */
export const snapshotContract = (
  contract: AnyContractRouter,
  window: Compatibility,
): ContractSnapshot => {
  const procedures: Record<string, ProcedureSnapshot> = {}
  const errors: Record<string, JsonSchema | null> = {}
  const walk = (node: unknown, path: readonly string[]): void => {
    if (isProcedure(node)) {
      procedures[path.join(".")] = describe(node)
      for (const [code, error] of Object.entries(node["~orpc"].errorMap)) {
        const data = error?.data === undefined ? null : toJson(error.data, "output")
        const known = errors[code]
        if (known !== undefined && JSON.stringify(known) !== JSON.stringify(data))
          throw new Error(`Error ${code} carries different data in different procedures.`)
        errors[code] = data
      }
      return
    }
    if (typeof node !== "object" || node === null) return
    for (const [key, inner] of Object.entries(node)) walk(inner, [...path, key])
  }
  walk(contract, [])
  const sorted = Object.fromEntries(
    Object.entries(errors).toSorted(([a], [b]) => a.localeCompare(b)),
  )
  return {
    revision: window.revision,
    oldestClient: window.oldestClient,
    oldestRunner: window.oldestRunner,
    errors: sorted,
    procedures,
  }
}

/**
 * `snapshot` as `contract.json` holds it: what fits on a line of 100 stays on one, so a change
 * reads as the few lines it touches.
 */
export const writeSnapshot = (snapshot: ContractSnapshot): string => {
  const width = 100
  const write = (value: unknown, indent: string, lead: string): string => {
    const flat = JSON.stringify(value)
    if (
      typeof value !== "object" ||
      value === null ||
      indent.length + lead.length + flat.length <= width
    )
      return flat
    const inner = `${indent}  `
    const lines = Array.isArray(value)
      ? value.map((item) => inner + write(item, inner, ""))
      : Object.entries(value).map(([key, item]) => {
          const name = `${JSON.stringify(key)}: `
          return inner + name + write(item, inner, name)
        })
    const [open, close] = Array.isArray(value) ? ["[", "]"] : ["{", "}"]
    return `${open}\n${lines.join(",\n")}\n${indent}${close}`
  }
  return `${write(snapshot, "", "")}\n`
}
