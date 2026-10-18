import { readFileSync } from "node:fs"
import { join } from "node:path"

// The part of a recorded-screen fixture reader the paste check's fixtures need: the check
// compares rows of text only, so a recorded screen reads back as its rows. A recording is
// sparse: `{ "height": 40, "rows": { "7": "text" } }`, where a row that shows nothing is
// left out.

type Recorded = { readonly height: number; readonly rows: { readonly [row: string]: string } }

const isRecorded = (value: unknown): value is Recorded =>
  typeof value === "object" &&
  value !== null &&
  "height" in value &&
  typeof value.height === "number" &&
  "rows" in value &&
  typeof value.rows === "object" &&
  value.rows !== null &&
  !Array.isArray(value.rows)

const revived = (value: unknown): unknown => {
  if (isRecorded(value))
    return Array.from({ length: value.height }, (_, row) => value.rows[row] ?? "")
  if (Array.isArray(value)) return value.map(revived)
  if (typeof value === "object" && value !== null)
    return Object.fromEntries(Object.entries(value).map(([key, each]) => [key, revived(each)]))
  return value
}

/**
 * A fixture in `src/fixtures`, with every recorded screen in it read back as its rows. The
 * `T` is the test's own account of the rest.
 */
export const loadFixture = <T>(name: string): T =>
  revived(JSON.parse(readFileSync(join(import.meta.dirname, "..", "fixtures", name), "utf8"))) as T
