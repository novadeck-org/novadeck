import { stat } from "node:fs/promises"

import { git } from "../checkouts/git.js"
import { mainBranch } from "../checkouts/repository.js"
import { logs } from "../log.js"
import { MainFetcher } from "./fetching.js"
import type { WorktreeRecord } from "./records.js"
import type { Closed, Worktrees } from "./worktrees.js"

const log = logs.for("worktrees")

/** Where a worktree's owner is: running or kept asleep, closed into History, or nowhere. */
export type OwnerState = "open" | "history" | "gone"

/** What cleanup needs of the runner. */
export type CleanupHost = {
  /** Where a terminal is. */
  readonly owner: (terminalId: string) => OwnerState
  /** Why a worktree must stay now (an agent works in it), or undefined. Read afresh each time. */
  readonly busy?: (row: WorktreeRecord) => Promise<string | undefined>
  readonly now?: () => number
  /** How often the worktrees are looked at, in milliseconds (a minute when omitted). */
  readonly sweepMs?: number
  readonly fetcher?: MainFetcher
}

/** A worktree a look found holding something stays unlooked-at, in the queue, this long unless it changes. */
const recheckMs = 15 * 60 * 1000

/** A worktree that stays because someone is in it, which the log leaves unsaid. */
const staying = (reason: string): boolean =>
  reason.startsWith("An agent is working") || reason === "Its owner is open."

/**
 * Removes the worktrees nobody needs. A merged worktree goes once its owner has closed or is
 * gone, and one with work in it stays until its owner leaves History for good; then it goes
 * with what it holds kept on refs. Merged is `Worktrees.closeAt`'s own test without `force`:
 * a worktree holding anything the main branch lacks is refused. Looked at every minute, after
 * the repositories' origins are fetched, and whenever a terminal closes.
 */
export class Cleanup {
  private timer: ReturnType<typeof setInterval> | undefined
  private stopped = false
  private active: Promise<unknown> = Promise.resolve()
  private waiting = false
  private fetchWanted = false
  /** The removals a prune started, which a stop waits for. */
  private readonly pruning = new Set<Promise<void>>()
  /** What a refused worktree looked like when it was refused, and when. */
  private readonly refused = new Map<string, { readonly key: string; readonly at: number }>()
  /** Where each worktree's index file is, found once. */
  private readonly indexes = new Map<string, string>()
  private readonly fetcher: MainFetcher

  constructor(
    private readonly service: Worktrees,
    private readonly host: CleanupHost,
  ) {
    this.fetcher = host.fetcher ?? new MainFetcher({ ...(host.now && { now: host.now }) })
  }

  /** When the repository's origin was last fetched. */
  fetchedAt(commonDir: string): number | undefined {
    return this.fetcher.fetchedAt(commonDir)
  }

  /** Starts the periodic look, and takes the first now. */
  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => this.request(true), this.host.sweepMs ?? 60_000)
    this.timer.unref()
    this.request(true)
  }

  /** Stops looking; resolves when a look under way has ended. */
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.timer = undefined
    this.fetcher.abort()
    await Promise.allSettled([this.active, ...this.pruning])
  }

  /** A terminal closed: look at once, without fetching. */
  closed(): void {
    this.request(false)
  }

  /** Looks, then resolves; for tests and callers that must wait. */
  look(fetch = false): Promise<void> {
    this.request(fetch)
    return this.active.then(() => undefined)
  }

  private request(fetch: boolean): void {
    if (this.stopped) return
    if (fetch) this.fetchWanted = true
    if (this.waiting) return
    this.waiting = true
    this.active = this.active.then(async () => {
      this.waiting = false
      const wanted = this.fetchWanted
      this.fetchWanted = false
      try {
        await this.sweep(wanted)
      } catch (error) {
        log.error("worktrees.cleanup-failed", "Novadeck could not look at its worktrees", {
          err: error,
        })
      }
    })
  }

  private get now(): number {
    return (this.host.now ?? Date.now)()
  }

  /**
   * What a worktree looks like from outside the queue, cheaply: its HEAD, the main branch's
   * commit and its index file's time. A worktree that looked so when it was last found
   * holding something still holds it, unless fifteen minutes have passed (a file written
   * without touching the index shows no other way). Undefined where it can't be read.
   */
  private async fingerprint(path: string): Promise<string | undefined> {
    const head = await git(path, ["rev-parse", "--verify", "-q", "HEAD"], { cap: 4096 })
    if (!head.ok) return undefined
    const main = await mainBranch(path)
    let index = this.indexes.get(path)
    if (index === undefined) {
      const found = await git(
        path,
        ["rev-parse", "--path-format=absolute", "--git-path", "index"],
        {
          cap: 4096,
        },
      )
      if (!found.ok) return undefined
      index = found.out.trim()
      this.indexes.set(path, index)
    }
    const stamp = (await stat(index).catch(() => undefined))?.mtimeMs ?? 0
    return `${head.out.trim()} ${main?.commit ?? "-"} ${stamp}`
  }

  private async sweep(fetch: boolean): Promise<void> {
    if (fetch) {
      await this.fetcher.fetchDue(this.service.all().map(({ commonDir }) => commonDir))
    }
    const rows = this.service.all()
    const tracked = new Set(rows.map(({ path }) => path))
    for (const path of this.refused.keys()) if (!tracked.has(path)) this.refused.delete(path)
    for (const row of rows) {
      if (this.stopped) return
      const state = row.terminalId === null ? "gone" : this.host.owner(row.terminalId)
      if (state === "open") continue
      // eslint-disable-next-line no-await-in-loop -- One at a time.
      const key = await this.fingerprint(row.path)
      const before = this.refused.get(row.path)
      if (key !== undefined && before?.key === key && this.now - before.at < recheckMs) continue
      // eslint-disable-next-line no-await-in-loop -- One removal at a time.
      const closed = await this.service
        .closeAt(row.path, false, (now) =>
          // Read again in the queue: the owner may have been restored or the worktree taken.
          now.terminalId !== null && this.host.owner(now.terminalId) === "open"
            ? Promise.resolve("Its owner is open.")
            : (this.host.busy?.(now) ?? Promise.resolve(undefined)),
        )
        .catch((error: unknown): Closed => ({ ok: false, reason: String(error) }))
      if (!closed.ok && key !== undefined && !staying(closed.reason))
        this.refused.set(row.path, { key, at: this.now })
      else this.refused.delete(row.path)
      this.report(row, closed, state === "history" ? "its owner closed" : "it has no owner")
    }
  }

  private report(row: WorktreeRecord, closed: Closed, why: string): void {
    if (closed.ok) {
      if (closed.already) return
      log.info("worktrees.cleaned", `Removed a merged worktree: ${why}`, {
        data: {
          path: row.path,
          branch: row.branch,
          branchDeleted: closed.branchDeleted,
          ...(closed.kept !== undefined && { kept: closed.kept }),
        },
      })
    } else if (!staying(closed.reason)) {
      // Holding work, or not merged: it stays, as every look will find.
      log.debug("worktrees.cleanup-kept", "A worktree stays", {
        data: { path: row.path, reason: closed.reason },
      })
    }
  }

  /**
   * Terminals left History for good (pruned): their worktrees go whatever they hold, with
   * uncommitted work and a detached HEAD kept on refs and an unmerged branch kept. One git
   * couldn't read, or with submodules, stays on disk with no owner, and is logged.
   */
  async pruned(terminalIds: readonly string[]): Promise<void> {
    if (this.stopped) return
    await Promise.all(
      terminalIds.flatMap((terminalId) =>
        this.service.ownedRows(terminalId).map((row) => {
          const removal = this.prune(row, terminalId).finally(() => this.pruning.delete(removal))
          this.pruning.add(removal)
          return removal
        }),
      ),
    )
  }

  private async prune(row: WorktreeRecord, terminalId: string): Promise<void> {
    let moved = false
    const closed = await this.service
      .closeAt(row.path, true, async (now) => {
        if (now.terminalId !== terminalId) {
          moved = true
          return "Its owner changed."
        }
        return this.host.busy?.(now)
      })
      .catch((error: unknown): Closed => ({ ok: false, reason: String(error) }))
    if (closed.ok) {
      if (closed.already) return
      log.info("worktrees.cleaned", "Removed a worktree: its owner left History", {
        data: {
          path: row.path,
          branch: row.branch,
          branchDeleted: closed.branchDeleted,
          ...(closed.kept !== undefined && { kept: closed.kept }),
          ...(closed.keptHead !== undefined && { keptHead: closed.keptHead }),
        },
      })
      return
    }
    if (moved) return
    await this.service.orphanIf(row.path, terminalId)
    log.warn("worktrees.cleanup-stayed", "A worktree stays on disk: its owner left History", {
      data: { path: row.path, branch: row.branch, reason: closed.reason },
    })
  }
}
