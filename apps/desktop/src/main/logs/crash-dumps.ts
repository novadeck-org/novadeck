// The crash reports Crashpad kept, logged once each.

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

import type { Log } from "@novadeck/log"

/** A crash report Crashpad kept: a minidump, by its name, size and time. */
type Dump = { readonly name: string; readonly size: number; readonly at: string }

/** The minidumps in `folder` and the folders right inside it, where Crashpad keeps them. */
const dumpsIn = (folder: string): Dump[] => {
  const found: Dump[] = []
  const visit = (where: string, depth: number): void => {
    let names: string[]
    try {
      names = readdirSync(where)
    } catch {
      return
    }
    for (const name of names) {
      const path = join(where, name)
      try {
        const stats = statSync(path)
        if (stats.isDirectory() && depth > 0) visit(path, depth - 1)
        else if (stats.isFile() && name.endsWith(".dmp"))
          found.push({ name: basename(path), size: stats.size, at: stats.mtime.toISOString() })
      } catch {
        // Gone since it was listed.
      }
    }
  }
  visit(folder, 2)
  return found
}

/**
 * Logs each crash report Crashpad kept in `folder` that no launch logged before: its name,
 * size and time, never what it holds. Which were logged is kept in `seenFile`.
 */
export const logNewDumps = (folder: string, seenFile: string, log: Log): void => {
  let seen: string[] = []
  try {
    const kept: unknown = JSON.parse(readFileSync(seenFile, "utf8"))
    if (Array.isArray(kept)) seen = kept.filter((name): name is string => typeof name === "string")
  } catch {
    // None logged yet.
  }
  const dumps = dumpsIn(folder)
  const fresh = dumps.filter((dump) => !seen.includes(dump.name))
  for (const dump of fresh)
    log.warn("crash.dump", "A crash report was kept.", {
      data: { name: dump.name, size: dump.size, at: dump.at },
    })
  if (fresh.length === 0) return
  try {
    // Only the dumps still there are remembered, so the file stays as small as the folder.
    writeFileSync(seenFile, JSON.stringify(dumps.map((dump) => dump.name)))
  } catch {
    // Logged again next time.
  }
}
