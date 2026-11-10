import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

import { logs } from "../log.js"

const log = logs.for("works")

/** What Works remembers of a checkout's work across runs. */
export type Remembered = {
  /** When the work first differed from main, in milliseconds since the epoch. */
  readonly firstSeenAt: number
  /** The tree the person last read it as; null before a first look. */
  readonly watermark: string | null
}

const isRemembered = (value: unknown): value is Remembered => {
  if (typeof value !== "object" || value === null) return false
  const { firstSeenAt, watermark } = value as { firstSeenAt?: unknown; watermark?: unknown }
  return (
    typeof firstSeenAt === "number" &&
    Number.isFinite(firstSeenAt) &&
    (watermark === null || (typeof watermark === "string" && /^[0-9a-f]{40,64}$/.test(watermark)))
  )
}

/**
 * What the runner remembers of the works, in a small JSON file beside its other state
 * (checkout to `Remembered`). Not the workspace database: losing it only means a work's
 * unread part starts again from all of it. Anything unreadable is a file with nothing in it.
 */
export const loadRemembered = async (path: string): Promise<Map<string, Remembered>> => {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"))
    const roots = (parsed as { roots?: unknown } | null)?.roots
    if (typeof roots !== "object" || roots === null) return new Map()
    return new Map(
      Object.entries(roots).filter((entry): entry is [string, Remembered] =>
        isRemembered(entry[1]),
      ),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      log.warn("works.memory-unreadable", "Novadeck could not read what it remembers of works", {
        err: error,
      })
    return new Map()
  }
}

/** Writes it whole, by writing beside and renaming, so a stop in between loses nothing. */
export const saveRemembered = async (
  path: string,
  roots: ReadonlyMap<string, Remembered>,
): Promise<void> => {
  try {
    await mkdir(dirname(path), { recursive: true })
    const temporary = `${path}.${process.pid}.tmp`
    await writeFile(temporary, JSON.stringify({ version: 1, roots: Object.fromEntries(roots) }))
    await rename(temporary, path)
  } catch (error) {
    log.warn("works.memory-unsaved", "Novadeck could not save what it remembers of works", {
      err: error,
    })
  }
}
