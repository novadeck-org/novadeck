import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { PullRequest as FoundPullRequest } from "@novadeck/forges"
import {
  forgeLimits,
  previewLimits,
  pullRequest as pullRequestSchema,
  workLimits,
  type PullRequest,
  type Work,
  type WorkChange,
  type WorkMade,
  type WorkPreview,
  type WorkPreviewWork,
} from "@novadeck/protocol"
import { KeyedChanges } from "@novadeck/wire/server"

import { waitAfter } from "../checkouts/git.js"
import { commonOf, targetOf, type Target } from "../checkouts/home.js"
import { listChanges, type Listed } from "../checkouts/listing.js"
import {
  branchOf,
  commonDir,
  landedIn,
  mainBranch,
  mergeBase,
  mergeTrees,
  snapshotCommit,
  treeGone,
  type Main,
  type Merge,
} from "../checkouts/repository.js"
import type { Held } from "../checkouts/repository.js"
import type { Snapshot, Snapshots } from "../checkouts/snapshots.js"
import { DomainError } from "../errors.js"
import { logs } from "../log.js"
import { folderOf, projectPathOf, repoPath } from "./folder.js"
import { landedByReflog } from "./landed.js"
import { conflictsOf, listFiles, mayConflict, type Detail, type Lines } from "./lines.js"
import { loadRemembered, RememberedSaves, type Remembered } from "./memory.js"
import { mergedWork } from "./merged.js"
import { carry, oversized, textAt } from "./preview.js"
import { safeOf, uncommittedOf, unpushedOf } from "./standing.js"

const log = logs.for("works")

/** What a preview answers of a file it does not read. */
const unreadable = (unavailable: "secret" | "binary" | "big"): WorkPreview => ({
  main: null,
  unavailable,
  works: [],
  renames: [],
})

/** A git worktree Novadeck tracks, which is a work: its folder, its project, its owner if any. */
export type Tracked = {
  readonly root: string
  readonly projectId: string
  readonly terminalId: string | null
  /** When it was recorded, in epoch milliseconds: the time of a work that differs from nothing. */
  readonly createdAt: number
  /** The commit it started from; undefined where that is not known. */
  readonly base?: string | undefined
  /** When its repository's origin was last fetched; undefined if never. */
  readonly fetchedAt?: number | undefined
  /** Its repository's git common dir, which `pullRequest` is asked by. */
  readonly commonDir?: string | undefined
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
   * after checking there that no agent works in it now (`Worktrees.closeAt`). `safe`: its work
   * lives elsewhere too (see `safeOf`), so what main lacks is no reason to ask first.
   */
  readonly remove: (root: string, force: boolean, safe?: boolean) => Promise<Removal>
  /** Fetches the origins of these repositories (git common dirs) now; resolves once each has ended. */
  readonly fetch?: (commonDirs: readonly string[]) => Promise<void>
  /** Calls the listener each time a worktree starts being tracked; returns what stops it. */
  readonly onMade?: (listener: (made: WorkMade) => void) => () => void
  /** What takes the checkouts' working trees as trees, shared with the changes items. */
  readonly snapshots: Snapshots
  /**
   * Where the first-seen times, last looks and files read are kept across runs; undefined:
   * not kept.
   */
  readonly memory?: string
  /**
   * A project's folder, for the work's `folder`; undefined where the project is unknown (its
   * works then name no folder).
   */
  readonly projectFolder?: (projectId: string) => string | undefined
  /** Which files (by full path) may hold secrets: a preview never reads them. */
  readonly held?: () => Held
  /**
   * The pull request of a branch in the repository at `commonDir`, where one is known; the
   * works carry it and know nothing else of where it comes from.
   */
  readonly pullRequest?: (commonDir: string, branch: string) => FoundPullRequest | undefined
  /** How often each checkout is read, in milliseconds. */
  readonly everyMs?: number
  /**
   * How long a watch waits for a fresh read of the works before `synced` is told with what was
   * read before, in milliseconds (1.5 s when not given).
   */
  readonly firstMs?: number
  /**
   * How long a watch waits for the very first read of the works, with nothing read before to
   * tell instead, in milliseconds (20 s when not given). `synced` without it would say there
   * are none.
   */
  readonly coldMs?: number
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
  /** Home's name, where the branch's key names one that isn't the repository's main. */
  readonly home: string | undefined
  /** Nothing differs and it has commits of its own that main holds: its work was merged. */
  readonly merged: boolean
  readonly changed: ReadonlyMap<string, Lines>
  /** How each changed file changed, and the object it is on the later side (see `Stamp`). */
  readonly kinds: ReadonlyMap<string, Kind>
  /** The paths it touches: each file's, and a renamed one's old path too. */
  readonly touched: ReadonlySet<string>
  readonly unread: ReadonlyMap<string, Lines> | undefined
  /** The files conflicting with main; undefined where this git can't tell. */
  readonly conflicts: readonly string[] | undefined
  /** Paths changed and not committed, as of the snapshot; undefined where git couldn't say. */
  readonly uncommitted: number | undefined
  /** HEAD's commits no remote holds, as of when it was read; undefined likewise. */
  readonly unpushed: number | undefined
  /** Untracked files over the size limit were left out of the snapshot. */
  readonly skipped: boolean
  readonly common: string | undefined
  /** Where the snapshot's objects are, which later git runs on it need. */
  readonly env: NodeJS.ProcessEnv | undefined
}

/** How a changed file changed, and its object on the later side of the listing. */
type Kind = {
  readonly status: Detail["status"]
  readonly from?: string
  readonly blob: string
}

/** When a file was first seen as the object it is now. */
type Stamp = { readonly blob: string; readonly at: number }

/**
 * The stamps after a read: a file keeps its stamp while its object stays, gets `now` when it is
 * new to the work or its object changed, and loses it when the work no longer changes it.
 */
const restamped = (
  stamps: ReadonlyMap<string, Stamp>,
  kinds: ReadonlyMap<string, Kind>,
  now: number,
): Map<string, Stamp> =>
  new Map(
    [...kinds].map(([path, { blob }]) => {
      const before = stamps.get(path)
      return [path, before?.blob === blob ? before : { blob, at: now }]
    }),
  )

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

/** How each file of a listing changed. */
const kindsOf = (listed: readonly Listed[]): Map<string, Kind> =>
  new Map(
    listed.map(({ path, status, oldPath, blob }) => [
      path,
      {
        status,
        ...(status === "renamed" && oldPath ? { from: oldPath } : {}),
        blob,
      },
    ]),
  )

/** The lines of each file a listing has. */
const linesOf = (listed: readonly Listed[]): Map<string, Lines> =>
  new Map(listed.map(({ path, added, removed }) => [path, { added, removed }]))

type RootState = {
  remembered: Remembered | undefined
  read: Read | undefined
  /** When each changed file was first seen as it is; kept in memory only. */
  stamps: ReadonlyMap<string, Stamp>
  /** Not read again before this time. */
  nextAt: number
}

/**
 * When the works' poll passes next, from `now`, given when each tracked checkout is due again:
 * as the first one comes due, and `every` after `now` at the latest, as a pass also tells who
 * works where and which worktrees are tracked. One due already (never read, or asked to be read
 * again, as after a merge that couldn't be told) waits for that pass, as it always has: waking
 * for it at once would read it over and over.
 */
export const nextWake = (now: number, every: number, dues: readonly number[]): number =>
  Math.min(now + every, ...dues.filter((nextAt) => nextAt > now))

/** How many checkouts that are no tracked worktree are remembered (those a changes item read). */
const keptAbandoned = 32
/** How many new pairs of works are merged in one pass. */
const pairsPerPass = 24

/**
 * The works: each tracked worktree against the repository's main branch, as the Worktrees panel
 * lists it, whoever owns it (or no one) and whether or not agent worktrees are on. A worktree
 * is read every few seconds while someone watches (longer after a slow read, and as soon as that
 * wait is over), by taking its working tree as a tree of git's own without touching the person's
 * index, and merging that in memory into main. A work is keyed by its worktree's root.
 */
export class Works {
  private readonly watchers = new Map<KeyedChanges<string, WorkChange>, string>()
  /** The `made` streams' ends, by owner: calling one ends its stream. */
  private readonly makers = new Map<() => void, string>()
  /** The works told, by root. */
  private readonly published = new Map<string, Work>()
  /** Each work's repository and the branch its checkout is on, as of the last pass. */
  private onBranches: readonly { readonly commonDir: string; readonly branch: string }[] = []
  private readonly roots = new Map<string, RootState>()
  /** The roots tracked as of the last pass: one that leaves was closed, by whoever. */
  private lastTracked = new Set<string>()
  /** The conflicts found between two snapshots, by their commits. */
  private readonly pairs = new Map<string, readonly string[]>()
  private readonly every: number
  private readonly first: number
  private readonly cold: number
  /** Whether a pass has told the works once: until then `published` is empty, not the works. */
  private passed = false
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
    this.cold = options.coldMs ?? 20_000
    this.now = options.now ?? Date.now
    this.saves = options.memory === undefined ? undefined : new RememberedSaves(options.memory)
    this.loaded =
      options.memory === undefined
        ? Promise.resolve()
        : loadRemembered(options.memory).then((roots) => {
            for (const [root, remembered] of roots)
              this.roots.set(root, { remembered, read: undefined, stamps: new Map(), nextAt: 0 })
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
    // A fresh read of every checkout may take a while; what is not in by then follows. The
    // first one ever is waited for, as nothing read before stands in for it.
    // With others already watching the works are as new as the last poll; else read afresh.
    const scanning = this.scan(!this.polling())
    const waiting = new AbortController()
    await Promise.race([
      scanning,
      sleep(this.passed ? this.first : this.cold, undefined, { signal: waiting.signal }).catch(
        () => {},
      ),
    ])
    waiting.abort()
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

  /**
   * Each worktree that starts being tracked from now on, until `signal` aborts or the owner
   * leaves. Nothing is replayed, and nothing is read from git.
   */
  async *made(ownerId: string, signal?: AbortSignal): AsyncGenerator<WorkMade> {
    if (this.stopped) throw new DomainError("CLOSING")
    const queue: WorkMade[] = []
    let wake: (() => void) | undefined
    let finished = signal?.aborted === true
    const end = () => {
      finished = true
      wake?.()
    }
    const stop = this.options.onMade?.((made) => {
      queue.push(made)
      wake?.()
    })
    this.makers.set(end, ownerId)
    signal?.addEventListener("abort", end, { once: true })
    try {
      while (true) {
        if (finished) return
        const next = queue.shift()
        if (next) {
          yield next
          continue
        }
        // eslint-disable-next-line no-await-in-loop -- Events are delivered in order.
        await new Promise<void>((resolve) => {
          wake = resolve
        })
        wake = undefined
      }
    } finally {
      signal?.removeEventListener("abort", end)
      this.makers.delete(end)
      stop?.()
    }
  }

  /**
   * The branches the works' checkouts are on, with their repositories, as the last pass read
   * them: what `pullRequest` is asked about.
   */
  branches(): readonly { readonly commonDir: string; readonly branch: string }[] {
    return this.onBranches
  }

  /**
   * A pull request as the wire takes it (only the contract's fields, a long title cut), or
   * undefined where it still isn't one: a forge's odd answer must not fail every work's stream.
   * The forge tells more than the contract carries (an open pull request's target branch, its
   * unfinished checks, for the agents' listing), which the strict schema would refuse.
   */
  private validPullRequest(found: FoundPullRequest | undefined): PullRequest | undefined {
    if (found === undefined) return undefined
    const { number, url, title, state, ci } = found
    const parsed = pullRequestSchema.safeParse({
      number,
      url,
      title: title.slice(0, forgeLimits.title),
      state,
      ...(ci !== undefined && { ci }),
    })
    if (parsed.success) return parsed.data
    log.warn("works.pull-request-invalid", "A forge's pull request does not fit the contract")
    return undefined
  }

  /** Whether a client watches the works, so they are being kept current. */
  watched(): boolean {
    return this.polling()
  }

  /** Ends the watch and made streams of an owner, as its connection goes. */
  release(ownerId: string): void {
    for (const [end, owner] of this.makers) if (owner === ownerId) end()
    for (const [watcher, owner] of this.watchers) if (owner === ownerId) watcher.finish()
  }

  /**
   * A file of a project (`path`, from its folder) as it would be once the project's works merge
   * onto main: main's copy and, for each work that changes the file, its hunks carried onto it,
   * read from the worktree as it is on disk now. Nothing of a file that may hold secrets, is
   * binary or is too large (`unavailable`), and `main: null` and no works where no work lists it.
   */
  async preview(projectId: string, path: string): Promise<WorkPreview> {
    if (!this.polling()) await this.scan(true)
    const nothing: WorkPreview = { main: null, works: [], renames: [] }
    const mine = [...this.published.values()].flatMap((work) => {
      const name = work.folder === undefined ? undefined : repoPath(work.folder, path)
      return work.projectId === projectId && work.folder !== undefined && name !== undefined
        ? [{ work, folder: work.folder, name }]
        : []
    })
    // A file main lacks because a work renamed another to it is read as the old file, which
    // that work's changes are against, and what other works did to the old file goes with it.
    const renamer = mine.flatMap(({ work, name }) => {
      const file = work.files.find((each) => each.path === name && each.status === "renamed")
      return file?.from === undefined ? [] : [{ work, file, from: file.from }]
    })[0]
    const source = renamer?.from ?? mine[0]?.name
    if (source === undefined) return nothing
    const listing = mine.flatMap(({ work, folder, name }) => {
      const own = work.files.find((each) => each.path === name)
      const old = source === name ? undefined : work.files.find((each) => each.path === source)
      const file = own ?? (old?.status === "renamed" ? undefined : old)
      if (!file) return []
      // The path the work's copy has, and the path main's merge base has it at.
      const there = file.path
      const was = file.status === "renamed" ? (file.from ?? file.path) : file.path
      return [{ work, folder, file, there, was }]
    })
    // The works that renamed the file itself, which main has, to another path.
    const renames = mine.flatMap(({ work, folder, name }) => {
      const file = work.files.find((each) => each.from === name && each.status === "renamed")
      const to = file === undefined ? undefined : projectPathOf(folder, file.path)
      return to === undefined
        ? []
        : [{ root: work.root, terminalId: work.terminalId, branch: work.branch, to }]
    })
    const first =
      listing[0]?.work ??
      mine.find(({ work }) => renames.some((each) => each.root === work.root))?.work
    if (!first) return nothing
    const held = this.options.held?.()
    if (
      held &&
      [...listing.map(({ work, there }) => join(work.root, there)), join(first.root, source)].some(
        held,
      )
    )
      return unreadable("secret")
    const main = await mainBranch(first.root)
    if (!main) return nothing
    const mainText = await textAt(first.root, `${main.commit}:${source}`)
    if (mainText === undefined) throw new DomainError("NOT_FOUND", "Main's copy can't be read.")
    const results = await Promise.all(
      listing.map(({ work, folder, file, there, was }) =>
        this.options.snapshots
          .use(work.root, async (checkout) => {
            const snapshot = await checkout.take(true)
            if (!snapshot || snapshot.head === "") return undefined
            const base = await mergeBase(work.root, main.commit, snapshot.head, snapshot.env)
            const [theirs, before] = await Promise.all([
              textAt(work.root, `${snapshot.tree}:${there}`, snapshot.env),
              base === undefined ? null : textAt(work.root, `${base}:${was}`, snapshot.env),
            ])
            if (theirs === undefined || before === undefined) return undefined
            const texts = [mainText, theirs, before]
            if (texts.some((text) => text !== null && text.includes("\0"))) return "binary" as const
            if (texts.some((text) => text !== null && text.length > previewLimits.text))
              return "big" as const
            const hunks = await carry(work.root, {
              main: mainText ?? "",
              base: before ?? "",
              theirs: theirs ?? "",
            })
            if (!hunks) return undefined
            if (oversized(hunks)) return "big" as const
            const from =
              file.status === "renamed" && file.from !== undefined
                ? projectPathOf(folder, file.from)
                : undefined
            const found: WorkPreviewWork = {
              root: work.root,
              terminalId: work.terminalId,
              branch: work.branch,
              status: theirs === null ? "deleted" : before === null ? "added" : "modified",
              changedAt: file.changedAt,
              ...(from !== undefined && { renamedFrom: from }),
              hunks,
            }
            return found
          })
          .catch(() => undefined),
      ),
    )
    const refused = results.find((each) => each === "binary" || each === "big")
    if (typeof refused === "string") return unreadable(refused)
    return {
      main: mainText,
      works: results
        .filter((each): each is WorkPreviewWork => typeof each === "object")
        .filter((each) => each.hunks.length > 0 || each.renamedFrom !== undefined)
        .slice(0, workLimits.conflicts),
      renames: renames.slice(0, workLimits.conflicts),
    }
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
   * confirm, unless it is safe to close (`safeOf`, read afresh now); any other refusal (its owner's agent is working in it, git couldn't be read) is a
   * CONFLICT saying why. What it remembered of the root goes with it.
   */
  async closeWork(root: string, force: boolean): Promise<WorkClosing> {
    const work = await this.workOf(root)
    if (work.working)
      throw new DomainError(
        "CONFLICT",
        "Its agent is working in that worktree right now: wait for its turn to end.",
      )
    // Not what was told a moment ago: read again, as a worktree safe then may not be now.
    const safe = force ? false : await this.safeNow(work)
    const closed = await this.options.remove(root, force, safe)
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

  /** Whether the work is safe to close as it stands now, from fresh reads of its checkout. */
  private safeNow(work: Work): Promise<boolean> {
    return this.exclusive(async () => {
      const row = this.options.tracked().find((each) => each.root === work.root)
      const state = this.roots.get(work.root)
      if (!row || !state) return false
      const read = await this.read(work.root, state, row.base, true)
      if (read === null || read === "keep") return false
      const found =
        row.commonDir !== undefined && read.branch !== null
          ? this.validPullRequest(this.options.pullRequest?.(row.commonDir, read.branch))
          : undefined
      return safeOf({ ...read, pullRequest: found }) === true
    }).catch(() => false)
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
      state = { remembered: undefined, read: undefined, stamps: new Map(), nextAt: 0 }
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
    for (const end of this.makers.keys()) end()
    await this.queue.catch(() => {})
    await this.saves?.settled()
  }

  /**
   * Fetches origin now in every repository the project's works are in, then reads those works
   * again, as main (and so merged, conflicts) may have moved. Resolves once every fetch has
   * ended, failed or not.
   */
  async fetch(projectId: string): Promise<void> {
    const mine = this.options.tracked().filter((row) => row.projectId === projectId)
    const repositories = [...new Set(mine.flatMap((row) => row.commonDir ?? []))]
    if (repositories.length === 0 || this.options.fetch === undefined) return
    await this.options.fetch(repositories)
    if (this.stopped) return
    await this.exclusive(() => this.pass(new Set(mine.map(({ root }) => root)))).catch(() => {})
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
          const now = this.now()
          const at = nextWake(
            now,
            this.every,
            this.options.tracked().flatMap(({ root }) => {
              const nextAt = this.roots.get(root)?.nextAt
              return nextAt === undefined ? [] : [nextAt]
            }),
          )
          // eslint-disable-next-line no-await-in-loop -- One pass after another.
          await sleep(at - now, undefined, { signal: loop.signal })
          // eslint-disable-next-line no-await-in-loop -- One pass after another.
          await this.scan(false, at)
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

  /**
   * Reads the checkouts that are due, or all of them where `afresh`; due by `wokeFor` too, the time
   * the poll woke for, as a timer may fire a moment before its time: a checkout due a millisecond
   * later would otherwise wait for the pass after.
   */
  private scan(afresh = false, wokeFor?: number): Promise<void> {
    return this.exclusive(() => this.pass(afresh ? "all" : new Set(), wokeFor)).catch(() => {})
  }

  /** Runs one thing at a time: a pass, or a look, which sets the watermark between passes. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run, run)
    this.queue = next.catch((error: unknown) => {
      log.error("works.pass-failed", "Reading works failed", { err: error })
    })
    return next
  }

  /**
   * One pass: reads the worktrees that are due (by `wokeFor`, where the poll woke for a time, and
   * those in `force`), then tells the works.
   */
  private async pass(force: ReadonlySet<string> | "all", wokeFor?: number): Promise<void> {
    await this.loaded
    const tracked = this.options.tracked()
    const presences = await this.options.presences()
    const by = Math.max(this.now(), wokeFor ?? -Infinity)
    const due = tracked.filter(({ root }) => {
      const state = this.roots.get(root)
      return force === "all" || force.has(root) || !state || by >= state.nextAt
    })
    // A few at a time: a repository of many files takes a while, and the others wait on it.
    for (let at = 0; at < due.length; at += 4)
      // eslint-disable-next-line no-await-in-loop -- A few checkouts at once.
      await Promise.all(due.slice(at, at + 4).map(({ root, base }) => this.readRoot(root, base)))
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
    this.passed = true
    this.remember()
  }

  /** Reads one checkout into its state; `start` is the commit it started from, if known. */
  private async readRoot(root: string, start: string | undefined): Promise<void> {
    let state = this.roots.get(root)
    if (!state) {
      state = { remembered: undefined, read: undefined, stamps: new Map(), nextAt: 0 }
      this.roots.set(root, state)
    }
    const started = this.now()
    try {
      const outcome = await this.read(root, state, start)
      if (outcome === "keep") {
        // Not told by this read (git was slow, or failed): what was told stands.
      } else {
        state.read = outcome ?? undefined
        state.stamps = restamped(state.stamps, outcome?.kinds ?? new Map(), started)
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
   * What the checkout differs from its target by (home, or the repository's main: see
   * `targetOf`; nothing, once merging it changes nothing), null when there is nothing to measure
   * by, "keep" when git failed and what was known stands. `start` is the row's start commit,
   * which the branch's own key overrides.
   */
  private async read(
    root: string,
    state: RootState,
    start: string | undefined,
    fresh = false,
  ): Promise<Read | null | "keep"> {
    const branch = await branchOf(root)
    const target = await targetOf(root, branch)
    if (!target) return null
    const { main } = target
    const from = target.base ?? start
    return this.options.snapshots.use(root, async (checkout) => {
      const snapshot = await checkout.take(fresh)
      if (!snapshot || snapshot.head === "") return "keep"
      const watermark = state.remembered?.watermark ?? null
      const key = [
        main.commit,
        // Another holder's move can make the work home without moving what it is measured by.
        target.holders.map((each) => each.commit).join(","),
        target.home,
        snapshot.tree,
        branch,
        watermark,
        snapshot.skipped,
        // Untracked files left out of the tree still count as uncommitted.
        snapshot.secret.join("\0"),
        snapshot.large,
        // A rebuilt folder may have let go of the snapshot's commit.
        snapshot.generation,
        // Commits that change no file leave the tree as it was, and make a work merged.
        snapshot.head,
        from,
      ].join(" ")
      // What the remotes hold moves without the key: a push, a fetch.
      const unpushed = await unpushedOf(root)
      if (state.read?.key === key) return { ...state.read, unpushed }
      return this.measure(root, state, {
        target,
        snapshot,
        branch,
        watermark,
        key,
        start: from,
        unpushed,
      })
    })
  }

  /** What a snapshot of the checkout differs from its target by, and what of it is unread. */
  private async measure(
    root: string,
    state: RootState,
    {
      target,
      snapshot,
      branch,
      watermark,
      key,
      start,
      unpushed,
    }: {
      readonly target: Target
      readonly snapshot: Snapshot
      readonly branch: string | null
      readonly watermark: string | null
      readonly key: string
      readonly start: string | undefined
      readonly unpushed: number | undefined
    },
  ): Promise<Read | "keep"> {
    const { main } = target
    const others = target.holders.filter((each) => each.commit !== main.commit)
    const home = target.home
    const uncommitted = await uncommittedOf(root, snapshot)
    const commit = await snapshotCommit(root, snapshot.tree, snapshot.head, snapshot.env)
    if (!commit) return "keep"
    // Differs from nothing: merged, squashed in or just made.
    const quiet = async (merged: boolean): Promise<Read> => ({
      key,
      commit,
      tree: snapshot.tree,
      branch,
      base: main.name,
      home,
      merged,
      changed: new Map(),
      kinds: new Map(),
      touched: new Set(),
      unread: undefined,
      conflicts: [],
      uncommitted,
      unpushed,
      skipped: snapshot.skipped,
      common: await commonDir(root),
      env: snapshot.env,
    })
    const nothing = async (): Promise<Read | "keep"> => {
      const merged = await mergedWork(root, main, snapshot.head, start)
      // Git failing is not an answer: what was told stands, and the next pass reads it again.
      if (merged === undefined) return "keep"
      if (merged) return quiet(true)
      // Landed by git itself: a merge of this branch into a holder, in its reflog. A fast-forward
      // one leaves history looking as if the branch only caught up, which `mergedWork` can't tell.
      if (
        await landedByReflog(
          root,
          await commonOf(root),
          target.holders.map((each) => each.name),
          branch,
          snapshot.head,
          start,
        )
      )
        return quiet(true)
      // Another holder counts only where merging into it changes nothing too: a worktree that
      // just caught up with home has commits main lacks, which are home's, not its own.
      for (const holder of others) {
        // eslint-disable-next-line no-await-in-loop -- Few holders, the first that holds it.
        const into = await mergeTrees(root, holder.commit, commit, snapshot.env)
        if (into.state !== "clean" || into.tree !== holder.tree) continue
        // eslint-disable-next-line no-await-in-loop -- As above.
        const there = await mergedWork(root, holder, snapshot.head, start)
        if (there === undefined) return "keep"
        if (there) return quiet(true)
      }
      return quiet(false)
    }
    const merge = await mergeTrees(root, main.commit, commit, snapshot.env)
    if (merge.state === "clean" && merge.tree === main.tree) return nothing()
    const base = await mergeBase(root, main.commit, commit, snapshot.env)
    // Counted as the changes item counts it, so a row says what its pane says.
    const listed = await listChanges(root, base ?? main.tree, snapshot.tree, snapshot.env)
    if (!Array.isArray(listed)) return "keep"
    const changed = linesOf(listed)
    // Nothing differs from where it left main (or this git can't merge, and nothing differs).
    if (changed.size === 0) return nothing()
    // It conflicts with main, but its work, uncommitted files and all, landed in main, which has
    // changed the same lines again since (a squash merge, then more of main's own): merged. Work
    // that merges cleanly but would change main is not: main reverted it, or it never landed.
    if (
      merge.state === "conflict" &&
      (await landedIn(root, main, commit, snapshot.env)) !== undefined
    )
      return quiet(true)
    // It differs from home, but another holder has all of it: the repository's main, where it
    // reached main some other way (a stacked pull request retargeted to main), or home's other side.
    if (await heldByAny(root, others, commit, snapshot.env)) return quiet(true)
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
      home,
      merged: false,
      changed,
      kinds: kindsOf(listed),
      touched: new Set(listed.flatMap(({ path, oldPath }) => (oldPath ? [path, oldPath] : [path]))),
      unread,
      conflicts:
        merge.state === "conflict" ? merge.files : merge.state === "clean" ? [] : undefined,
      uncommitted,
      unpushed,
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
        stamps: this.roots.get(row.root)?.stamps,
        remembered: this.roots.get(row.root)?.remembered,
      }))
      .filter((each): each is typeof each & { read: Read } => each.read !== undefined)
    const between = await this.between(reads)
    const owners = new Map(reads.map(({ root, terminalId }) => [root, terminalId]))
    const folders = new Map(
      await Promise.all(
        reads.map(
          async ({ root, projectId, read }) =>
            [root, await folderOf(this.options.projectFolder?.(projectId), read.common)] as const,
        ),
      ),
    )
    this.onBranches = reads.flatMap((each) =>
      each.commonDir !== undefined && each.read.branch !== null
        ? [{ commonDir: each.commonDir, branch: each.read.branch }]
        : [],
    )
    const found = new Map<string, Work>()
    for (const {
      root,
      terminalId,
      projectId,
      createdAt,
      fetchedAt,
      commonDir: repository,
      read,
      remembered,
      stamps,
    } of reads) {
      const mine = between.get(root) ?? new Map<string, Set<string>>()
      const conflicting = new Set([
        ...(read.conflicts ?? []),
        ...[...mine.values()].flatMap((f) => [...f]),
      ])
      const details = new Map<string, Detail>(
        [...read.kinds].map(([path, { status, from }]) => [
          path,
          {
            status,
            ...(from !== undefined && { from }),
            changedAt: stamps?.get(path)?.at ?? 0,
          },
        ]),
      )
      const listed = listFiles(read.changed, read.unread, conflicting, details)
      const folder = folders.get(root)
      const request =
        repository !== undefined && read.branch !== null
          ? this.validPullRequest(this.options.pullRequest?.(repository, read.branch))
          : undefined
      const safe = safeOf({ ...read, pullRequest: request })
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
        ...(read.home !== undefined && { home: read.home }),
        merged: read.merged,
        // Only a main that a fetch moves (a remote-tracking ref) is as old as the fetch.
        ...(fetchedAt !== undefined && read.base.startsWith("origin/") && { fetchedAt }),
        firstSeenAt: remembered?.firstSeenAt ?? createdAt,
        added: listed.total.added,
        removed: listed.total.removed,
        unreadAdded: listed.totalUnread.added,
        unreadRemoved: listed.totalUnread.removed,
        files: listed.files,
        truncated: listed.truncated || read.skipped,
        ...(folder !== undefined && { folder }),
        ...(request !== undefined && { pullRequest: request }),
        ...(read.uncommitted !== undefined && { uncommitted: read.uncommitted }),
        ...(read.unpushed !== undefined && { unpushed: read.unpushed }),
        ...(safe !== undefined && { safe }),
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

/**
 * Whether one of `holders` already has all of `commit`: merging it in changes nothing, or it
 * conflicts only because the holder changed the same lines again after the work landed in it.
 */
const heldByAny = async (
  root: string,
  holders: readonly Main[],
  commit: string,
  env: NodeJS.ProcessEnv | undefined,
): Promise<boolean> => {
  for (const holder of holders) {
    // eslint-disable-next-line no-await-in-loop -- Few holders, the first that holds it.
    const merge = await mergeTrees(root, holder.commit, commit, env)
    if (merge.state === "clean" && merge.tree === holder.tree) return true
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (merge.state === "conflict" && (await landedIn(root, holder, commit, env)) !== undefined)
      return true
  }
  return false
}
