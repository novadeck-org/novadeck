import { readFileSync } from "node:fs"
import { join } from "node:path"

import type { ScreenText } from "../terminals/screen.js"
import { screen } from "./screens.js"

/**
 * A screen as a probe records it, and the one format every probe fixture of a screen
 * keeps, whatever harness drew it and whatever it was probed for. It is sparse: a row
 * that shows nothing is left out.
 */
export type ScreenRecord = {
  /** How many rows it holds: the screen's own, or those up to the last that shows anything. */
  readonly height: number
  /** Its columns, where the probe knew them; 80 otherwise. */
  readonly columns?: number
  /** Where the cursor was; on the last row that shows anything where the probe didn't say. */
  readonly cursor?: { readonly row: number; readonly column: number }
  /** The rows that show anything, by row number, as `screenText` reads them. */
  readonly rows: { readonly [row: string]: string }
  /** The rows whose dim cells blank some of their text, as they read undimmed. Others read as `rows` do. */
  readonly bright?: { readonly [row: string]: string }
  /** Whether the terminal took bracketed pastes; it did unless this says not. */
  readonly bracketedPaste?: boolean
  /** What a probe noted of each row's styling, for a reader's eyes: no test reads it. */
  readonly styles?: unknown
}

/** The record of a screen, as a probe writes it: from the emulator's `screenText`, or from the text a terminal showed. */
export const screenRecord = (
  shown: ScreenText | string,
  size: { readonly columns?: number | undefined } = {},
): ScreenRecord => {
  const read = typeof shown === "string" ? undefined : shown
  const rows = typeof shown === "string" ? shown.split("\n") : shown.rows
  // Text keeps only the rows up to the last that shows anything.
  const height = read ? rows.length : rows.findLastIndex((row) => row.trim() !== "") + 1
  const sparse = (from: readonly string[]): { [row: string]: string } =>
    Object.fromEntries(
      from.slice(0, height).flatMap((row, index) => (row === "" ? [] : [[String(index), row]])),
    )
  const columns = read?.columns ?? size.columns
  const lit = read?.bright
  return {
    height,
    ...(columns !== undefined && { columns }),
    ...(read && { cursor: read.cursor }),
    rows: sparse(rows),
    ...(lit && {
      bright: Object.fromEntries(
        Object.entries(sparse(rows)).flatMap(([row]) =>
          lit[Number(row)] === rows[Number(row)] ? [] : [[row, lit[Number(row)] ?? ""]],
        ),
      ),
    }),
    ...(read && !read.bracketedPaste && { bracketedPaste: false }),
  }
}

/** A record as the screen it recorded. */
export const screenOf = (record: ScreenRecord): ScreenText => {
  const rows = Array.from({ length: record.height }, (_, row) => record.rows[row] ?? "")
  return screen({
    rows,
    bright: rows.map((row, index) => record.bright?.[index] ?? row),
    ...(record.columns !== undefined && { columns: record.columns }),
    ...(record.cursor && { cursor: record.cursor }),
    ...(record.bracketedPaste !== undefined && { bracketedPaste: record.bracketedPaste }),
  })
}

const isRecord = (value: unknown): value is ScreenRecord =>
  typeof value === "object" &&
  value !== null &&
  "height" in value &&
  typeof value.height === "number" &&
  "rows" in value &&
  typeof value.rows === "object" &&
  value.rows !== null &&
  !Array.isArray(value.rows)

const revived = (value: unknown): unknown => {
  if (isRecord(value)) return screenOf(value)
  if (Array.isArray(value)) return value.map(revived)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, revived(each)]))
  return value
}

/**
 * A probe fixture, `fixtures/<name>` beside the module whose folder is `folder`
 * (`import.meta.dirname`): the JSON a probe recorded, its every screen (a `ScreenRecord`)
 * read as the `ScreenText` it recorded. The `T` is the test's own account of the rest.
 */
export const loadProbe = <T>(folder: string, name: string): T =>
  revived(JSON.parse(readFileSync(join(folder, "fixtures", name), "utf8"))) as T
