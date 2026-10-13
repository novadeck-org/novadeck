import type { Anchor } from "./atlas.ts"

// The runner lens's contract: owned by extract/runner-lens.ts and pages/runner*.
// The runner from the inside: each procedure's path to the SQL it runs, and the store's
// statements by method. Found by reading the source, so it follows only what reads plainly.

export type SqlVerb = "read" | "write" | "delete"

// A table a statement touches, and how.
export type Touch = { table: string; verb: SqlVerb }

export type Statement = {
  // One line, with interpolations as `?`.
  sql: string
  kind: "select" | "insert" | "update" | "delete"
  touches: Touch[]
  anchor: Anchor
}

// A method of the workspace store that runs SQL (or only calls methods that do).
export type StoreMethod = {
  name: string
  anchor: Anchor
  statements: Statement[]
  // Other store methods it calls on the way.
  calls: string[]
  // What its own statements do, per table (read, write, delete, merged).
  touches: Touch[]
  // The table it works on most, to sort it by; null when it runs no SQL itself.
  home: string | null
  // Procedures that reach it, by id.
  usedBy: string[]
}

// One stop on a procedure's way down: the router handler, then service methods.
export type Step = {
  label: string
  anchor: Anchor
  depth: number
  // Store methods this step calls directly.
  store: string[]
}

export type ProcedureTrace = {
  id: string
  steps: Step[]
  // Every store method the path reaches, with the store method that called it (null: the
  // service called it directly).
  reached: { method: string; from: string | null }[]
  // Whether any SQL was reached. False means "no store call found", not "no SQL".
  traced: boolean
}

export type RunnerLens = {
  // The tables, in the order the matrix lays them out.
  tables: string[]
  methods: StoreMethod[]
  procedures: ProcedureTrace[]
  statements: number
}
