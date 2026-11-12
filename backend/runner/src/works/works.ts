import { setTimeout as sleep } from "node:timers/promises"

import { workLimits, type Work, type WorkChange } from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

import { waitAfter } from "../checkouts/git.js"
import { listChanges, type Listed } from "../checkouts/listing.js"
import {
  branchOf,
  commonDir,
  mainBranch,
  mergeBase,
  mergeTrees,
  snapshotCommit,
  treeGone,
  type Main,
  type Merge,
} from "../checkouts/repository.js"
import type { Snapshot, Snapshots } from "../checkouts/snapshots.js"
import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { conflictsOf, listFiles, mayConflict, type Lines } from "./lines.js"
import { loadRemembered, RememberedSaves, type Remembered } from "./memory.js"

const log = logs.for("works")

/** A git worktree Novadeck tracks, which is a work: its folder, its project, its owner if any. */
export type Tracked = {
  readonly root: string
  readonly projectId: string
  readonly terminalId: string | null
  /** When it was recorded, in epoch milliseconds: the time of a work that differs from nothing. */
  readonly createdAt: number
  /** When its repository's origin was last fetched; undefined if never. */
  readonly fetchedAt?: number | undefined
}

/** A running terminal, the git checkout it works in now (its top folder) and whether its agent is mid-turn. */
export type Presence = {
  readonly terminalId: string
  readonly root: string
  readonly working: boolean
}

/** What closing a worktree comes to: see `Worktrees.close`. */
export type Removal =
  | {
      readonly ok: true
      readonly kept?: string
      /** Where commits only a detached HEAD reached were kept. */
      readonly keptHead?: string
      readonly branchDeleted: boolean
    }
  /** Refused; `holds` says what the worktree holds where only that stands in the way of `force`. */
  | { readonly ok: false; readonly reason: string; readonly holds?: string }

/** What closing a work comes to for the person: closed, or in need of their say first. */
export type WorkClosing =
  | { readonly closed: true; kept?: string; keptHead?: string; branchDeleted: boolean }
  | { readonly closed: false; readonly holds: string }

export type WorksOptions = {
  /** The worktrees Novadeck tracks, whether or not agent worktrees are on: the works. */
  readonly tracked: () => readonly Tracked[]
  /** The open terminals that are in a git checkout, which, and whether their agents work. */
  readonly presences: () => Promise<readonly Presence[]>
  /** Shows the work's changes on the terminal's bar; resolves to the item's id. */
  readonly show: (terminalId: string, root: string) => Promise<string>
  /**
   * Closes the tracked worktree at `root` for the person, in the worktrees service's queue,
   * after checking there that no agent works in it now (`Worktrees.closeAt`).
   */
  readonly remove: (root: string, force: boolean) => Promise<Removal>
  /** What takes the checkouts' working trees as trees, shared with the changes items. */
  readonly snapshots: Snapshots
  /**
   * Where the first-seen times, last looks and files read are kept across runs; undefined:
   * not kept.
   */
  readonly memory?: string
  /** How often each checkout is read, in milliseconds. */
  readonly everyMs?: number
  /**
   * How long a watch waits for the first sight of the works before `synced` is told without
   * it, in milliseconds (1.5 s when not given).
   */
  readonly firstMs?: number
  readonly now?: () => number
}

/**
 * What a checkout differs from main by, as last read. Nothing (`changed` empty) when it is
 * merged, squashed in or just made.
 */
type Read = {
  readonly key: string
  readonly commit: string
  readonly tree: string
  readonly branch: string | null
  readonly base: string
  readonly changed: ReadonlyMap<string, Lines>
  /** The paths it touches: each file's, and a renamed one's old path too. */
  readonly touched: ReadonlySet<string>
  readonly unread: ReadonlyMap<string, Lines> | undefined
  /** The files conflicting with main; undefined where this git can't tell. */
  readonly conflicts: readonly string[] | undefined
  /** Untracked files over the size limit were left out of the snapshot. */
  readonly skipped: boolean
  readonly common: string | undefined
  /** Where the snapshot's objects are, which later git runs on it need. */
  readonly env: NodeJS.ProcessEnv | undefined
}

/** What is remembered, without the marks of files the work no longer changes. */
const withoutUnchanged = (
  remembered: Remembered,
  changed: ReadonlyMap<string, Lines>,
): Remembered => {
  if (!remembered.read) return remembered
  const kept = Object.entries(remembered.read).filter(([path]) => changed.has(path))
  if (kept.length === Object.keys(remembered.read).length) return remembered
  const { read: _read, ...rest } = remembered
  return kept.length === 0 ? rest : { ...rest, read: Object.fromEntries(kept) }
}

/** The lines of each file a listing has. */
const linesOf = (listed: readonly Listed[]): Map<string, Lines> =>
  new Map(listed.map(({ path, added, removed }) => [path, { added, removed }]))

type RootState = {
  remembered: Remembered | undefined
  read: Read | undefined
  /** Not read again before this time. */
  nextAt: number
}

/** How many checkouts that are no tracked worktree are remembered (those a changes item read). */
const keptAbandoned = 32
/** How many new pairs of works are merged in one pass. */
const pairsPerPass = 24

/**
 * The works: each tracked worktree against the repository's main branch, as the Changes panel
 * lists it, whoever owns it (or no one) and whether or not agent worktrees are on. A worktree
 * is read every few seconds while someone watches (longer after a slow read), by taking its
 * working tree as a tree of git's own without touching the person's index, and merging that in
 * memory into main. A work is keyed by its worktree's root.
 */
export class Works {
  private readonly watchers = new Map<KeyedChanges<string, WorkChange>, string>()
  /** The works told, by root. */
  private readonly published = new Map<string, Work>()
  private readonly roots = new Map<string, RootState>()
  /** The roots tracked as of the last pass: one that leaves was closed, by whoever. */
  private lastTracked = new Set<string>()
  /** The conflicts found between two snapshots, by their commits. */
  private readonly pairs = new Map<string, readonly string[]>()
  private readonly every: number
  private readonly first: number
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private loop: AbortController | undefined
  private loaded: Promise<void>
  private saved = ""
  private readonly saves: RememberedSaves | undefined
  private stopped = false

  constructor(private readonly options: WorksOptions) {
    this.every = options.everyMs ?? 3000
    this.first = options.firstMs ?? 1_500
    this.now = options.now ?? Date.now
    this.saves = options.memory === undefined ? undefined : new RememberedSaves(options.memory)
    this.loaded =
      options.memory === undefined
        ? Promise.resolve()
        : loadRemembered(options.memory).then((roots) => {
            for (const [root, remembered] of roots)
              this.roots.set(root, { remembered, read: undefined, nextAt: 0 })
            this.saved = this.serialized()
          })
    // A rebuilt object folder keeps the trees the works were last read as.
    options.snapshots.keep((root) => {
      const watermark = this.roots.get(root)?.remembered?.watermark
      return watermark ? [watermark] : []
    })
  }

  /** Every work, `synced`, then each later change, until `signal` aborts or the owner leaves. */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<WorkChange> {
    if (this.stopped) throw new DomainError("CLOSING")
    // The first sight of every checkout may take a while; what is not in by then follows.
    // With others already watching the works are as new as the last poll; else read afresh.
    const scanning = this.scan(!this.polling())
    await Promise.race([scanning, sleep(this.first)])
    const watcher = new KeyedChanges<string, WorkChange>(
      [...this.published].map(([root, work]) => [root, { type: "changed", work }] as const),
      { type: "synced" },
    )
    this.watchers.set(watcher, ownerId)
    this.poll()
    const abort = () => watcher.finish()
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) watcher.finish()
    try {
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- Changes are delivered in order.
        const change = await watcher.next()
        if (change === undefined) return
        yield change
      }
    } finally {
      signal?.removeEventListener("abort", abort)
      watcher.finish()
      this.watchers.delete(watcher)
      if (this.watchers.size === 0) this.loop?.abort()
    }
  }

  /** Ends the watch streams of an owner, as its connection goes. */
  release(ownerId: string): void {
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
  }

  /** The person has read the work at `root` as it is now; NOT_FOUND without one. */
  async look(root: string): Promise<void> {
    const work = await this.workOf(root)
    await this.exclusive(async () => {
      const state = this.roots.get(work.root)
      if (!state?.remembered) return
      // As it is now, not as a snapshot of a moment ago.
      const snapshot = await this.options.snapshots.use(work.root, (checkout) =>
        checkout.take(true),
      )
      const tree = snapshot?.tree ?? state.read?.tree
      if (tree === undefined) return
      state.remembered = { ...state.remembered, watermark: tree }
      state.nextAt = 0
      await this.pass(new Set([work.root]))
    })
  }

  /**
   * Shows the work at `root` as a changes item on its owner's bar, or on `terminalId`'s where
   * it has no owner or its owner has no bar (it is closed, in History); NOT_FOUND without a
   * work, or without a terminal to show it on.
   */
  async show(root: string, terminalId?: string): Promise<{ readonly itemId: string }> {
    const work = await this.workOf(root)
    const on = work.terminalId ?? terminalId
    if (on === undefined)
      throw new DomainError("NOT_FOUND", "That work has no terminal to show it on.")
    try {
      return { itemId: await this.options.show(on, work.root) }
    } catch (error) {
      if (
        !(error instanceof DomainError && error.code === "TERMINAL_NOT_FOUND") ||
        terminalId === undefined ||
        terminalId === on
      )
        throw error
      return { itemId: await this.options.show(terminalId, work.root) }
    }
  }

  /**
   * Closes the worktree of the work at `root` for the person. Without `force`, one that holds
   * files or commits main lacks is not closed but answered with what it holds, for the person to
   * confirm; any other refusal (its owner's agent is working in it, git couldn't be read) is a
   * CONFLICT saying why. What it remembered of the root goes with it.
   */
  async closeWork(root: string, force: boolean): Promise<WorkClosing> {
    const work = await this.workOf(root)
    if (work.working)
      throw new DomainError(
        "CONFLICT",
        "Its agent is working in that worktree right now: wait for its turn to end.",
      )
    const closed = await this.options.remove(root, force)
    if (!closed.ok) {
      if (closed.holds !== undefined && !force) return { closed: false, holds: closed.holds }
      throw new DomainError("CONFLICT", closed.reason)
    }
    await this.exclusive(async () => {
      this.roots.delete(root)
      this.options.snapshots.forget(root)
      await this.pass(new Set())
    })
    return {
      closed: true,
      ...(closed.kept !== undefined && { kept: closed.kept }),
      ...(closed.keptHead !== undefined && { keptHead: closed.keptHead }),
      branchDeleted: closed.branchDeleted,
    }
  }

  /**
   * The person has read a file of a checkout's work as `blob`, its object as the changes item
   * listed it (all zeros where it was deleted): it reads as read while it stays that.
   */
  async markRead(root: string, path: string, blob: string): Promise<void> {
    await this.loaded
    // At once, not behind a pass: the changes item's next read names it. A pass under way sets
    // what it remembers from what is there when it ends, this mark too.
    let state = this.roots.get(root)
    if (!state) {
      state = { remembered: undefined, read: undefined, nextAt: 0 }
      this.roots.set(root, state)
    }
    const remembered = state.remembered ?? { firstSeenAt: this.now(), watermark: null }
    state.remembered = { ...remembered, read: { ...remembered.read, [path]: blob } }
    this.remember()
  }

  /** The files of a checkout read, each by the object it was read as. */
  marks(root: string): ReadonlyMap<string, string> {
    return new Map(Object.entries(this.roots.get(root)?.remembered?.read ?? {}))
  }

  /** Ends every stream, once what is being read and saved is done. */
  async close(): Promise<void> {
    this.stopped = true
    this.loop?.abort()
    for (const watcher of this.watchers.keys()) watcher.finish()
    await this.queue.catch(() => {})
    await this.saves?.settled()
  }

  /** The work at `root`, read now if nobody is watching to keep them current. */
  private async workOf(root: string): Promise<Work> {
    if (!this.polling()) await this.scan(true)
    const work = this.published.get(root)
    if (!work) throw new DomainError("NOT_FOUND", "Novadeck tracks no worktree there.")
    return work
  }

  /** Reads the works every few seconds while there is a watcher. */
  private poll(): void {
    if (this.polling() || this.stopped) return
    const loop = new AbortController()
    this.loop = loop
    void (async () => {
      try {
        while (!loop.signal.aborted) {
          // eslint-disable-next-line no-await-in-loop -- One pass after another.
          await sleep(this.every, undefined, { signal: loop.signal })
          // eslint-disable-next-line no-await-in-loop -- One pass after another.
          await this.scan()
        }
      } catch (error) {
        if (!loop.signal.aborted)
          log.error("works.poll-failed", "Reading works failed", { err: error })
      } finally {
        if (this.loop === loop) this.loop = undefined
      }
    })()
  }

  /** Whether the works are being read every few seconds. */
  private polling(): boolean {
    return this.loop !== undefined && !this.loop.signal.aborted
  }

  /** Reads the checkouts that are due, or all of them where `afresh`. */
  private scan(afresh = false): Promise<void> {
    return this.exclusive(() => this.pass(afresh ? "all" : new Set())).catch(() => {})
  }

  /** Runs one thing at a time: a pass, or a look, which sets the watermark between passes. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch((error: unknown) => {
      log.error("works.pass-failed", "Reading works failed", { err: error })
    })
    return next
  }

  /** One pass: reads the worktrees that are due (and those in `force`), then tells the works. */
  private async pass(force: ReadonlySet<string> | "all"): Promise<void> {
    await this.loaded
    const tracked = this.options.tracked()
    const presences = await this.options.presences()
    const now = this.now()
    const due = tracked
      .map(({ root }) => root)
      .filter((root) => {
        const state = this.roots.get(root)
        return force === "all" || force.has(root) || !state || now >= state.nextAt
      })
    // A few at a time: a repository of many files takes a while, and the others wait on it.
    for (let at = 0; at < due.length; at += 4)
      // eslint-disable-next-line no-await-in-loop -- A few checkouts at once.
      await Promise.all(due.slice(at, at + 4).map((root) => this.readRoot(root)))
    const tracking = new Set(tracked.map(({ root }) => root))
    // A worktree closed (by the person, an agent's close, or cleanup) takes its memory with it.
    for (const root of this.lastTracked)
      if (!tracking.has(root)) {
        this.roots.delete(root)
        this.options.snapshots.forget(root)
      }
    this.lastTracked = tracking
    this.forgetAbandoned(tracking, new Set(presences.map((each) => each.root)))
    const found = await this.compose(tracked, presences)
    this.publish(found)
    this.remember()
  }

  /** Reads one checkout into its state. */
  private async readRoot(root: string): Promise<void> {
    let state = this.roots.get(root)
    if (!state) {
      state = { remembered: undefined, read: undefined, nextAt: 0 }
      this.roots.set(root, state)
    }
    const started = this.now()
    try {
      const outcome = await this.read(root, state)
      if (outcome === "keep") {
        // Not told by this read (git was slow, or failed): what was told stands.
      } else {
        state.read = outcome ?? undefined
        // Nothing differs: merged, squashed in or just made. What was remembered starts over.
        if (outcome && outcome.changed.size === 0) state.remembered = undefined
        else if (outcome) {
          state.remembered ??= { firstSeenAt: started, watermark: null }
          state.remembered = withoutUnchanged(state.remembered, outcome.changed)
        }
      }
    } catch (error) {
      log.error("works.read-failed", "Reading a checkout failed", { err: error })
    }
    state.nextAt = this.now() + waitAfter(this.now() - started, this.every)
  }

  /**
   * What the checkout differs from main by (nothing, once merging it changes nothing), null
   * when its repository has no main branch, "keep" when git failed and what was known stands.
   */
  private async read(root: string, state: RootState): Promise<Read | null | "keep"> {
    const main = await mainBranch(root)
    if (!main) return null
    return this.options.snapshots.use(root, async (checkout) => {
      const snapshot = await checkout.take()
      if (!snapshot || snapshot.head === "") return "keep"
      const branch = await branchOf(root)
      const watermark = state.remembered?.watermark ?? null
      const key = [
        main.commit,
        snapshot.tree,
        branch,
        watermark,
        snapshot.skipped,
        // A rebuilt folder may have let go of the snapshot's commit.
        snapshot.generation,
      ].join(" ")
      if (state.read?.key === key) return state.read
      return this.measure(root, state, { main, snapshot, branch, watermark, key })
    })
  }

  /** What a snapshot of the checkout differs from main by, and what of it is unread. */
  private async measure(
    root: string,
    state: RootState,
    {
      main,
      snapshot,
      branch,
      watermark,
      key,
    }: {
      readonly main: Main
      readonly snapshot: Snapshot
      readonly branch: string | null
      readonly watermark: string | null
      readonly key: string
    },
  ): Promise<Read | "keep"> {
    const commit = await snapshotCommit(root, snapshot.tree, snapshot.head, snapshot.env)
    if (!commit) return "keep"
    const nothing = async (): Promise<Read> => ({
      key,
      commit,
      tree: snapshot.tree,
      branch,
      base: main.name,
      changed: new Map(),
      touched: new Set(),
      unread: undefined,
      conflicts: [],
      skipped: snapshot.skipped,
      common: await commonDir(root),
      env: snapshot.env,
    })
    const merge = await mergeTrees(root, main.commit, commit, snapshot.env)
    if (merge.state === "clean" && merge.tree === main.tree) return nothing()
    const base = await mergeBase(root, main.commit, commit, snapshot.env)
    // Counted as the changes item counts it, so a row says what its pane says.
    const listed = await listChanges(root, base ?? main.tree, snapshot.tree, snapshot.env)
    if (!Array.isArray(listed)) return "keep"
    const changed = linesOf(listed)
    // Nothing differs from where it left main (or this git can't merge, and nothing differs).
    if (changed.size === 0) return nothing()
    let unread: ReadonlyMap<string, Lines> | undefined
    if (watermark !== null) {
      const since = await listChanges(root, watermark, snapshot.tree, snapshot.env)
      if (Array.isArray(since))
        unread = new Map([...linesOf(since)].filter(([path]) => changed.has(path)))
      // The tree it was last read as is gone: all of it reads as unread again.
      else if (state.remembered && (await treeGone(root, watermark, snapshot.env)))
        state.remembered = { ...state.remembered, watermark: null }
      // Git was slow or the list too long, not the tree gone: the unread lines stand.
      else unread = state.read?.unread
    }
    return {
      key,
      commit,
      tree: snapshot.tree,
      branch,
      base: main.name,
      changed,
      touched: new Set(listed.flatMap(({ path, oldPath }) => (oldPath ? [path, oldPath] : [path]))),
      unread,
      conflicts:
        merge.state === "conflict" ? merge.files : merge.state === "clean" ? [] : undefined,
      skipped: snapshot.skipped,
      common: await commonDir(root),
      env: snapshot.env,
    }
  }

  /** The works as they stand: each tracked worktree's last read, and conflicts among them. */
  private async compose(
    tracked: readonly Tracked[],
    presences: readonly Presence[],
  ): Promise<Map<string, Work>> {
    const reads = tracked
      .map((row) => ({
        ...row,
        read: this.roots.get(row.root)?.read,
        remembered: this.roots.get(row.root)?.remembered,
      }))
      .filter((each): each is typeof each & { read: Read } => each.read !== undefined)
    const between = await this.between(reads)
    const owners = new Map(reads.map(({ root, terminalId }) => [root, terminalId]))
    const found = new Map<string, Work>()
    for (const { root, terminalId, projectId, createdAt, fetchedAt, read, remembered } of reads) {
      const mine = between.get(root) ?? new Map<string, Set<string>>()
      const conflicting = new Set([
        ...(read.conflicts ?? []),
        ...[...mine.values()].flatMap((f) => [...f]),
      ])
      const listed = listFiles(read.changed, read.unread, conflicting)
      found.set(root, {
        root,
        terminalId,
        projectId,
        working:
          terminalId !== null &&
          presences.some(
            (each) => each.terminalId === terminalId && each.root === root && each.working,
          ),
        branch: read.branch,
        base: read.base,
        // Only a main that a fetch moves (a remote-tracking ref) is as old as the fetch.
        ...(fetchedAt !== undefined && read.base.startsWith("origin/") && { fetchedAt }),
        firstSeenAt: remembered?.firstSeenAt ?? createdAt,
        added: listed.total.added,
        removed: listed.total.removed,
        unreadAdded: listed.totalUnread.added,
        unreadRemoved: listed.totalUnread.removed,
        files: listed.files,
        truncated: listed.truncated || read.skipped,
        conflicts: conflictsOf(
          (read.conflicts?.length ?? 0) > 0,
          [...mine.keys()].map((other) => ({ root: other, terminalId: owners.get(other) ?? null })),
        ),
      })
    }
    return found
  }

  /**
   * The works of one repository that conflict with each other: for each root, the others it
   * conflicts with and the files. Works that changed no file in common are not merged at all.
   */
  private async between(
    reads: readonly { root: string; read: Read }[],
  ): Promise<Map<string, Map<string, Set<string>>>> {
    const result = new Map<string, Map<string, Set<string>>>()
    let budget = pairsPerPass
    const add = (root: string, other: string, files: readonly string[]) => {
      const mine = result.get(root) ?? new Map<string, Set<string>>()
      mine.set(other, new Set(files))
      result.set(root, mine)
    }
    const sets = reads.map(({ read }) => ({
      // A rename touches its old path too, which another work may have changed.
      paths: read.touched,
      truncated: read.changed.size > workLimits.files || read.skipped,
    }))
    for (let first = 0; first < reads.length; first += 1)
      for (let second = first + 1; second < reads.length; second += 1) {
        const a = reads[first]!
        const b = reads[second]!
        if (!a.read.common || a.read.common !== b.read.common) continue
        // A worktree that differs from nothing conflicts with nothing.
        if (a.read.changed.size === 0 || b.read.changed.size === 0) continue
        if (!mayConflict(sets[first]!, sets[second]!)) continue
        const key = `${a.read.commit} ${b.read.commit}`
        let files = this.pairs.get(key)
        if (!files) {
          if (budget === 0) continue
          budget -= 1
          // eslint-disable-next-line no-await-in-loop -- Each pair is merged in turn.
          const merge = await this.options.snapshots
            .use(a.root, () => mergeTrees(a.root, a.read.commit, b.read.commit, a.read.env))
            .catch((): Merge => ({ state: "unknown" }))
          if (merge.state === "unknown") {
            // Not known is not "no conflict": nothing is stored, and the two checkouts are read
            // afresh next pass, as a snapshot commit may be gone (its folder rebuilt).
            for (const each of [a, b]) {
              const state = this.roots.get(each.root)
              if (!state?.read) continue
              state.read = { ...state.read, key: "" }
              state.nextAt = 0
            }
            continue
          }
          files = merge.state === "conflict" ? merge.files : []
          if (this.pairs.size > 256) this.pairs.clear()
          this.pairs.set(key, files)
        }
        if (files.length === 0) continue
        add(a.root, b.root, files)
        add(b.root, a.root, files)
      }
    return result
  }

  /** Tells the watchers what differs from the works told before. */
  private publish(found: ReadonlyMap<string, Work>): void {
    for (const [root, old] of this.published)
      if (!found.has(root)) {
        this.published.delete(root)
        for (const watcher of this.watchers.keys())
          watcher.removed(root, { type: "removed", root, projectId: old.projectId })
      }
    for (const [root, work] of found) {
      const old = this.published.get(root)
      if (old && JSON.stringify(old) === JSON.stringify(work)) continue
      this.published.set(root, work)
      for (const watcher of this.watchers.keys()) watcher.changed(root, { type: "changed", work })
    }
  }

  /** Forgets the checkouts that are no tracked worktree, but the latest few that have a memory. */
  private forgetAbandoned(tracked: ReadonlySet<string>, inUse: ReadonlySet<string>): void {
    // The checkouts terminals work in now stay, as a changes item reads their files' marks.
    const abandoned = [...this.roots].filter(([root]) => !tracked.has(root) && !inUse.has(root))
    const keep = abandoned
      .filter(([, state]) => state.remembered)
      .toSorted(([, a], [, b]) => b.remembered!.firstSeenAt - a.remembered!.firstSeenAt)
      .slice(0, keptAbandoned)
    for (const [root] of abandoned)
      if (!keep.some(([kept]) => kept === root)) {
        this.roots.delete(root)
        this.options.snapshots.forget(root)
      }
  }

  private serialized(): string {
    return JSON.stringify(
      [...this.roots].flatMap(([root, state]) =>
        state.remembered ? [[root, state.remembered]] : [],
      ),
    )
  }

  /** Keeps the first-seen times and last looks, when they changed. */
  private remember(): void {
    if (!this.saves) return
    const now = this.serialized()
    if (now === this.saved) return
    this.saved = now
    this.saves.save(
      new Map(
        [...this.roots].flatMap(([root, state]) =>
          state.remembered ? [[root, state.remembered]] : [],
        ),
      ),
    )
  }
}
