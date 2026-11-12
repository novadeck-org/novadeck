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

/** A worktree that stays because someone is in it, which the log leaves unsaid. */
const staying = (reason: string): boolean => reason.startsWith("An agent is working")

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
    await this.active
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

  private async sweep(fetch: boolean): Promise<void> {
    if (fetch) {
      await this.fetcher.fetchDue(this.service.all().map(({ commonDir }) => commonDir))
    }
    for (const row of this.service.all()) {
      if (this.stopped) return
      const state = row.terminalId === null ? "gone" : this.host.owner(row.terminalId)
      if (state === "open") continue
      // eslint-disable-next-line no-await-in-loop -- One removal at a time.
      const closed = await this.service
        // Read again in the queue: the owner may have been restored or the worktree taken.
        .closeAt(row.path, false, async (now) =>
          now.terminalId !== null && this.host.owner(now.terminalId) === "open"
            ? "Its owner is open."
            : await this.host.busy?.(now),
        )
        .catch((error: unknown): Closed => ({ ok: false, reason: String(error) }))
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
    await Promise.all(
      terminalIds.flatMap((terminalId) =>
        this.service.ownedRows(terminalId).map((row) => this.prune(row, terminalId)),
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
