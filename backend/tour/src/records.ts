import { readFileSync, renameSync, writeFileSync } from "node:fs"

import { z } from "zod"

/**
 * What a run of the tour was given, for its folder: the service's endpoint and the ticket the
 * tour's agents' provider takes as its key, when the ticket was said to end, and its lead.
 */
export type TourRecord = {
  readonly endpoint: string
  readonly ticket: string
  readonly expiresAt?: string | undefined
  /** The terminal its lead's brief was rung to, which opens its teammates, a restart after too. */
  readonly lead?: string | undefined
}

const record = z.object({
  endpoint: z.string().min(1),
  ticket: z.string().min(1),
  expiresAt: z.string().optional(),
  lead: z.string().optional(),
})

/**
 * The tour's runs by the name of their folder (`tour`, `tour-2`), kept in a small file of the
 * runner's own (beside its database, never in the tour's folder, and never in the workspace's
 * schema), so a runner started again still gives the tour's agents the provider the tour pays
 * for: resumed terminals of the tour's folder keep the model on their command lines, and without
 * the ticket they would reach for the person's own account. A record stays through the person
 * keeping the project and through its ticket's end (a dead ticket is the service's refusal, never
 * the person's account), and goes with the project (`Tour.launchEnv`) or when a new run takes
 * its folder. The file holds a ticket, so it is the runner's owner's alone. Without a path
 * (a runner that keeps no database) records live in memory.
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
