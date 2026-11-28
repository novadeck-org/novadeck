import { readFileSync, renameSync, writeFileSync } from "node:fs"

import { z } from "zod"

/** A run of the tour, for its folder: its lead, once its brief was rung. */
export type TourRecord = {
  /** The terminal its lead's brief was rung to, which opens its teammates, a restart after too. */
  readonly lead?: string | undefined
}

const record = z.object({ lead: z.string().optional() })

/**
 * The tour's runs by the name of their folder (`tour`, `tour-2`), kept in a small file of the
 * runner's own (beside its database, never in the tour's folder, and never in the workspace's
 * schema), so a lead resumed in a runner started again still opens its teammates (`Tour.leads`).
 * A new run in a folder replaces its record. Without a path (a runner that keeps no database)
 * records live in memory.
 */
export class TourRecords {
  private readonly runs = new Map<string, TourRecord>()

  constructor(private readonly path?: string) {
    if (path === undefined) return
    try {
      const stored: unknown = JSON.parse(readFileSync(path, "utf8"))
      if (typeof stored !== "object" || stored === null) return
      for (const [folder, value] of Object.entries(stored)) {
        const read = record.safeParse(value)
        if (read.success) this.runs.set(folder, read.data)
      }
    } catch {
      // None yet, or unreadable: no run is remembered.
    }
  }

  get(folder: string): TourRecord | undefined {
    return this.runs.get(folder)
  }

  set(folder: string, run: TourRecord): void {
    this.runs.set(folder, run)
    this.save()
  }

  delete(folder: string): void {
    if (this.runs.delete(folder)) this.save()
  }

  private save(): void {
    if (this.path === undefined) return
    try {
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.runs)), { mode: 0o600 })
      renameSync(temporary, this.path)
    } catch {
      // Not kept: this runner still has it in memory.
    }
  }
}
