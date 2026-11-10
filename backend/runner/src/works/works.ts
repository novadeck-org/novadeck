import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { workLimits, type Work, type WorkChange } from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

import { waitAfter } from "../companions/changes.js"
import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { attribute, conflictsOf, listFiles, mayConflict, type Claim, type Lines } from "./lines.js"
import { loadRemembered, saveRemembered, type Remembered } from "./memory.js"
import {
  branchOf,
  commonDir,
  mainBranch,
  mergeBase,
  mergeTrees,
  numstat,
  snapshotCommit,
  snapshotTree,
} from "./repository.js"

const log = logs.for("works")

/** A running terminal and the git checkout it works in now (its top folder). */
export type Placement = {
  readonly terminalId: string
  readonly projectId: string
  readonly root: string
}

export type WorksOptions = {
  /** The open terminals that are in a git checkout, and which. */
  readonly placements: () => Promise<readonly Placement[]>
  /** Shows the checkout's changes on the terminal's bar; resolves to the item's id. */
  readonly show: (terminalId: string, root: string) => Promise<string>
  /** Where the first-seen times and last looks are kept across runs; undefined: not kept. */
  readonly memory?: string
  /** How often each checkout is read, in milliseconds. */
  readonly everyMs?: number
  readonly now?: () => number
}

/** What a checkout differs from main by, as last read. */
type Read = {
  readonly key: string
  readonly commit: string
  readonly tree: string
  readonly branch: string | null
  readonly base: string
  readonly changed: ReadonlyMap<string, Lines>
  readonly unread: ReadonlyMap<string, Lines> | undefined
  /** The files conflicting with main; undefined where this git can't tell. */
  readonly conflicts: readonly string[] | undefined
  readonly common: string | undefined
}

type RootState = {
  remembered: Remembered | undefined
  read: Read | undefined
  /** Not read again before this time. */
  nextAt: number
  /** Whether the private index holds the checkout (else it starts from HEAD). */
  indexed: boolean
}

/** How long the first sight of the works is waited for before `synced` is told without it. */
const firstMs = 1_500
/** How many checkouts no terminal is in are remembered. */
const keptAbandoned = 32
/** How many new pairs of works are merged in one pass. */
const pairsPerPass = 24

/**
 * Each open terminal's work: its checkout against the repository's main branch, as the
 * Changes panel lists it. A checkout is read every few seconds while someone watches
 * (longer after a slow read), by taking its working tree as a tree of git's own without
 * touching the person's index, and merging that in memory into main. One work per checkout:
 * when several terminals are in the same, it is the one of the terminal that has been in it
 * longest (the owner keeps it for as long as it is there).
 */
export class Works {
  private readonly watchers = new Map<KeyedChanges<string, WorkChange>, string>()
  /** The works told, by terminal. */
  private readonly published = new Map<string, Work>()
  private readonly roots = new Map<string, RootState>()
  /** Who owns each checkout's work; since when each terminal has been in each checkout. */
  private owners = new Map<string, string>()
  private readonly since = new Map<string, number>()
  /** The conflicts found between two snapshots, by their commits. */
  private readonly pairs = new Map<string, readonly string[]>()
  private readonly every: number
  private readonly now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private loop: AbortController | undefined
  private folder: Promise<string> | undefined
  private loaded: Promise<void>
  private saved = ""
  private stopped = false

  constructor(private readonly options: WorksOptions) {
    this.every = options.everyMs ?? 3000
    this.now = options.now ?? Date.now
    this.loaded =
      options.memory === undefined
        ? Promise.resolve()
        : loadRemembered(options.memory).then((roots) => {
            for (const [root, remembered] of roots)
              this.roots.set(root, { remembered, read: undefined, nextAt: 0, indexed: false })
            this.saved = this.serialized()
          })
  }

  /** Every work, `synced`, then each later change, until `signal` aborts or the owner leaves. */
  async *watch(ownerId: string, signal?: AbortSignal): AsyncGenerator<WorkChange> {
    if (this.stopped) throw new DomainError("CLOSING")
    // The first sight of every checkout may take a while; what is not in by then follows.
    // With others already watching the works are as new as the last poll; else read afresh.
    const scanning = this.scan(!this.polling())
    await Promise.race([scanning, sleep(firstMs)])
    const watcher = new KeyedChanges<string, WorkChange>(
      [...this.published].map(([, work]) => [work.terminalId, { type: "changed", work }] as const),
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

  /** The person has read the terminal's work as it is now; NOT_FOUND without one. */
  async look(terminalId: string): Promise<void> {
    const work = await this.workOf(terminalId)
    await this.exclusive(async () => {
      const state = this.roots.get(work.root)
      if (!state?.remembered) return
      const index = await this.privateIndex(work.root)
      const snapshot = await snapshotTree(work.root, index, !state.indexed)
      state.indexed = snapshot !== undefined
      const tree = snapshot?.tree ?? state.read?.tree
      if (tree === undefined) return
      state.remembered = { ...state.remembered, watermark: tree }
      state.nextAt = 0
      await this.pass(new Set([work.root]))
    })
  }

  /** Shows the terminal's work as a changes item on its bar; NOT_FOUND without one. */
  async show(terminalId: string): Promise<{ readonly itemId: string }> {
    const work = await this.workOf(terminalId)
    return { itemId: await this.options.show(terminalId, work.root) }
  }

  /** Ends every stream and forgets the private indexes. */
  async close(): Promise<void> {
    this.stopped = true
    this.loop?.abort()
    for (const watcher of this.watchers.keys()) watcher.finish()
    await this.queue.catch(() => {})
    const folder = await this.folder?.catch(() => undefined)
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {})
  }

  /** The terminal's work, read now if nobody is watching to keep them current. */
  private async workOf(terminalId: string): Promise<Work> {
    if (!this.polling()) await this.scan(true)
    const work = this.published.get(terminalId)
    if (!work) throw new DomainError("NOT_FOUND", "That terminal has no changes to show.")
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

  /** The folder holding the private index files, made when first needed. */
  private async privateIndex(root: string): Promise<string> {
    this.folder ??= mkdtemp(join(tmpdir(), "novadeck-works-"))
    const name = createHash("sha1").update(root).digest("hex").slice(0, 16)
    return join(await this.folder, name)
  }

  /** The terminals' checkouts: who owns each, and every terminal's project. */
  private async claims(): Promise<{
    readonly owners: ReadonlyMap<string, string>
    readonly projects: ReadonlyMap<string, string>
  }> {
    await this.loaded
    const placements = await this.options.placements()
    const now = this.now()
    const live = new Set<string>()
    const claims: Claim[] = placements.map(({ terminalId, root }) => {
      const key = `${terminalId}\0${root}`
      live.add(key)
      if (!this.since.has(key)) this.since.set(key, now)
      return { terminalId, root, since: this.since.get(key)! }
    })
    for (const key of this.since.keys()) if (!live.has(key)) this.since.delete(key)
    this.owners = attribute(claims, this.owners)
    return {
      owners: this.owners,
      projects: new Map(placements.map(({ terminalId, projectId }) => [terminalId, projectId])),
    }
  }

  /** One pass: reads the checkouts that are due (and those in `force`), then tells the works. */
  private async pass(force: ReadonlySet<string> | "all"): Promise<void> {
    const { owners, projects } = await this.claims()
    const now = this.now()
    const due = [...owners.keys()].filter((root) => {
      const state = this.roots.get(root)
      return force === "all" || force.has(root) || !state || now >= state.nextAt
    })
    // A few at a time: a repository of many files takes a while, and the others wait on it.
    for (let at = 0; at < due.length; at += 4)
      // eslint-disable-next-line no-await-in-loop -- A few checkouts at once.
      await Promise.all(due.slice(at, at + 4).map((root) => this.readRoot(root)))
    this.forgetAbandoned(owners)
    const found = await this.compose(owners, projects)
    this.publish(found)
    this.remember()
  }

  /** Reads one checkout into its state. */
  private async readRoot(root: string): Promise<void> {
    let state = this.roots.get(root)
    if (!state) {
      state = { remembered: undefined, read: undefined, nextAt: 0, indexed: false }
      this.roots.set(root, state)
    }
    const started = this.now()
    try {
      const outcome = await this.read(root, state)
      if (outcome === "keep") {
        // Not told by this read (git was slow, or failed): what was told stands.
      } else if (outcome === "merged") {
        state.read = undefined
        state.remembered = undefined
      } else {
        state.read = outcome ?? undefined
        if (outcome) state.remembered ??= { firstSeenAt: started, watermark: null }
      }
    } catch (error) {
      log.error("works.read-failed", "Reading a checkout failed", { err: error })
    }
    state.nextAt = this.now() + waitAfter(this.now() - started, this.every)
  }

  /**
   * What the checkout differs from main by: "merged" when merging it changes nothing (it is
   * merged, squashed in or discarded), null when its repository has no main branch,
   * "keep" when git failed and what was known stands.
   */
  private async read(root: string, state: RootState): Promise<Read | null | "merged" | "keep"> {
    const main = await mainBranch(root)
    if (!main) return null
    const index = await this.privateIndex(root)
    const snapshot = await snapshotTree(root, index, !state.indexed)
    state.indexed = snapshot !== undefined
    if (!snapshot) {
      await rm(index, { force: true })
      await rm(`${index}.lock`, { force: true })
      return "keep"
    }
    const branch = await branchOf(root)
    const watermark = state.remembered?.watermark ?? null
    const key = [main.commit, snapshot.tree, branch, watermark].join(" ")
    if (state.read?.key === key) return state.read
    const commit = await snapshotCommit(root, snapshot.tree, snapshot.head)
    if (!commit) return "keep"
    const merge = await mergeTrees(root, main.commit, commit)
    if (merge.state === "clean" && merge.tree === main.tree) return "merged"
    const base = await mergeBase(root, main.commit, commit)
    const changed = await numstat(root, base ?? main.tree, snapshot.tree)
    if (!changed) return "keep"
    // Nothing differs from where it left main (or this git can't merge, and nothing differs).
    if (changed.size === 0) return "merged"
    let unread: Map<string, Lines> | undefined
    if (watermark !== null) {
      const since = await numstat(root, watermark, snapshot.tree)
      if (since) unread = new Map([...since].filter(([path]) => changed.has(path)))
      // The tree it was last read as is gone: all of it reads as unread again.
      else if (state.remembered) state.remembered = { ...state.remembered, watermark: null }
    }
    return {
      key,
      commit,
      tree: snapshot.tree,
      branch,
      base: main.name,
      changed,
      unread,
      conflicts:
        merge.state === "conflict" ? merge.files : merge.state === "clean" ? [] : undefined,
      common: await commonDir(root),
    }
  }

  /** The works as they stand: each owned checkout's last read, and conflicts among them. */
  private async compose(
    owners: ReadonlyMap<string, string>,
    projects: ReadonlyMap<string, string>,
  ): Promise<Map<string, Work>> {
    const reads = [...owners]
      .map(([root, terminalId]) => ({
        root,
        terminalId,
        read: this.roots.get(root)?.read,
        remembered: this.roots.get(root)?.remembered,
        projectId: projects.get(terminalId),
      }))
      .filter(
        (each): each is typeof each & { read: Read; remembered: Remembered; projectId: string } =>
          each.read !== undefined && each.remembered !== undefined && each.projectId !== undefined,
      )
    const between = await this.between(reads)
    const found = new Map<string, Work>()
    for (const { root, terminalId, read, remembered, projectId } of reads) {
      const mine = between.get(terminalId) ?? new Map<string, Set<string>>()
      const conflicting = new Set([
        ...(read.conflicts ?? []),
        ...[...mine.values()].flatMap((f) => [...f]),
      ])
      const listed = listFiles(read.changed, read.unread, conflicting)
      found.set(terminalId, {
        terminalId,
        projectId,
        root,
        branch: read.branch,
        base: read.base,
        firstSeenAt: remembered.firstSeenAt,
        added: listed.total.added,
        removed: listed.total.removed,
        unreadAdded: listed.totalUnread.added,
        unreadRemoved: listed.totalUnread.removed,
        files: listed.files,
        truncated: listed.truncated,
        conflicts: conflictsOf((read.conflicts?.length ?? 0) > 0, [...mine.keys()]),
      })
    }
    return found
  }

  /**
   * The works of one repository that conflict with each other: for each terminal, the
   * others it conflicts with and the files. Works that changed no file in common are not
   * merged at all.
   */
  private async between(
    reads: readonly { root: string; terminalId: string; read: Read }[],
  ): Promise<Map<string, Map<string, Set<string>>>> {
    const result = new Map<string, Map<string, Set<string>>>()
    let budget = pairsPerPass
    const add = (terminalId: string, other: string, files: readonly string[]) => {
      const mine = result.get(terminalId) ?? new Map<string, Set<string>>()
      mine.set(other, new Set(files))
      result.set(terminalId, mine)
    }
    const sets = reads.map(({ read }) => ({
      paths: new Set(read.changed.keys()),
      truncated: read.changed.size > workLimits.files,
    }))
    for (let first = 0; first < reads.length; first += 1)
      for (let second = first + 1; second < reads.length; second += 1) {
        const a = reads[first]!
        const b = reads[second]!
        if (!a.read.common || a.read.common !== b.read.common) continue
        if (!mayConflict(sets[first]!, sets[second]!)) continue
        const key = `${a.read.commit} ${b.read.commit}`
        let files = this.pairs.get(key)
        if (!files) {
          if (budget === 0) continue
          budget -= 1
          // eslint-disable-next-line no-await-in-loop -- Each pair is merged in turn.
          const merge = await mergeTrees(a.root, a.read.commit, b.read.commit)
          files = merge.state === "conflict" ? merge.files : []
          if (this.pairs.size > 256) this.pairs.clear()
          this.pairs.set(key, files)
        }
        if (files.length === 0) continue
        add(a.terminalId, b.terminalId, files)
        add(b.terminalId, a.terminalId, files)
      }
    return result
  }

  /** Tells the watchers what differs from the works told before. */
  private publish(found: ReadonlyMap<string, Work>): void {
    for (const [terminalId, old] of this.published)
      if (!found.has(terminalId)) {
        this.published.delete(terminalId)
        for (const watcher of this.watchers.keys())
          watcher.removed(terminalId, {
            type: "removed",
            terminalId,
            projectId: old.projectId,
          })
      }
    for (const [terminalId, work] of found) {
      const old = this.published.get(terminalId)
      if (old && JSON.stringify(old) === JSON.stringify(work)) continue
      this.published.set(terminalId, work)
      for (const watcher of this.watchers.keys())
        watcher.changed(terminalId, { type: "changed", work })
    }
  }

  /** Forgets the checkouts no terminal is in, but the latest few that have a work. */
  private forgetAbandoned(owners: ReadonlyMap<string, string>): void {
    const abandoned = [...this.roots].filter(([root]) => !owners.has(root))
    const keep = abandoned
      .filter(([, state]) => state.remembered)
      .toSorted(([, a], [, b]) => b.remembered!.firstSeenAt - a.remembered!.firstSeenAt)
      .slice(0, keptAbandoned)
    for (const [root] of abandoned)
      if (!keep.some(([kept]) => kept === root)) {
        this.roots.delete(root)
        void this.privateIndex(root).then((index) => rm(index, { force: true }))
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
    const { memory } = this.options
    if (memory === undefined) return
    const now = this.serialized()
    if (now === this.saved) return
    this.saved = now
    void saveRemembered(
      memory,
      new Map(
        [...this.roots].flatMap(([root, state]) =>
          state.remembered ? [[root, state.remembered]] : [],
        ),
      ),
    )
  }
}
