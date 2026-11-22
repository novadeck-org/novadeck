import { existsSync } from "node:fs"
import { mkdir, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { currentBranch, keysOfBranch, writeKeys } from "../checkouts/home.js"
import { behindMain, mainBranch } from "../checkouts/repository.js"
import { logs } from "../log.js"
import { Cleanup, type CleanupHost, type OwnerState } from "./cleanup.js"
import type { WorktreeRecord, WorktreeRecords } from "./records.js"
import {
  addWorktree,
  branchTip,
  commitAt,
  deleteBranch,
  entriesOf,
  finishRemoval,
  forgetEntry,
  hasSubmodules,
  heldByAny,
  headOf,
  homeOf,
  keepStrayHead,
  keepWork,
  nestedRepositories,
  nestedWork,
  removeFolder,
  repositoryAt,
  said,
  setUpstream,
  standingOf,
  startOf,
  validBranch,
} from "./repo.js"
import { worktreesRoot } from "./root.js"

const log = logs.for("worktrees")

/** What the service needs of the runner. */
export type WorktreesHost = {
  /** Whether the terminal exists, live or closed but still in History. */
  readonly exists: (terminalId: string) => boolean
  /** The folder of the project, whose repositories a worktree may be adopted from. */
  readonly projectFolder?: (projectId: string) => string | undefined
  /** The folder the worktrees live in; `~/.novadeck/worktrees` when omitted. */
  readonly root?: string
  readonly now?: () => number
  readonly platform?: NodeJS.Platform
  /** Where a terminal is, for cleanup; an existing terminal reads as open when omitted. */
  readonly owner?: (terminalId: string) => OwnerState
  /** Why a worktree must stay now (an agent works in it), read afresh by cleanup before a removal. */
  readonly busy?: CleanupHost["busy"]
  /** Cleanup's own timing and fetcher, which tests replace. */
  readonly cleanup?: Pick<CleanupHost, "sweepMs" | "fetcher">
  /** Repositories beyond the tracked worktrees' that are kept fetched (compares of remote refs). */
  readonly repositories?: () => Promise<readonly string[]>
  /** The runner's own folder for git's hooks to be pointed at while a checkout moves. */
  readonly hooksFolder?: string
  /** How long a new worktree waits for the remote's main; five seconds when omitted. */
  readonly freshMainMs?: number
}

type Failure = { readonly ok: false; readonly reason: string }
const refused = (reason: string): Failure => ({ ok: false, reason })

/** A close refused only for what the worktree holds, which `force` would keep on refs. */
type Holding = Failure & {
  /** What it holds, as the person reads it ("2 uncommitted or untracked paths"). */
  readonly holds: string
}

/** The instruction files at a worktree's top, which harnesses don't load from an added folder. */
const instructionFiles = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const

/** A worktree Novadeck started tracking: its folder and its project. */
export type Made = { readonly root: string; readonly projectId: string }

/**
 * A tracked worktree that changed hands (given, taken from its owner once the person allowed it,
 * taken with no owner left, or its terminal restored from History) or stopped being tracked
 * (closed, cleaned up, or gone from disk).
 */
export type WorktreeChange =
  | {
      readonly type: "moved"
      readonly root: string
      readonly from: string | null
      readonly to: string
    }
  | { readonly type: "removed"; readonly root: string }

/**
 * What origin has of a branch opened with no local one and no `from`: `current`, origin has it
 * now, and the new branch starts from it; `unchecked`, origin couldn't be asked, and the new
 * branch starts from it as last fetched; `gone`, origin no longer has it (only an earlier fetch
 * left it), and the new branch starts as one with no `from` does.
 */
export type OriginBranch = "current" | "unchecked" | "gone"

export type Opened = {
  readonly ok: true
  readonly path: string
  readonly branch: string
  /** Whether the branch already existed here and was checked out. */
  readonly existing: boolean
  readonly base: string
  /** Where the branch was only origin's: what origin has of it (see `OriginBranch`). */
  readonly origin?: OriginBranch
  /** Whether the new branch tracks origin's, where it starts from it. */
  readonly tracking?: boolean
  /** The paths of the instruction files at its top. */
  readonly instructions: readonly string[]
  /** Its home (see `homeSaid`); undefined where the repository has no main and none was given. */
  readonly home?: string
}

export type Taken =
  | {
      readonly ok: true
      readonly path: string
      readonly branch: string
      readonly already?: true
      /** Its home, as `Opened`'s. */
      readonly home?: string
    }
  /** Another live terminal owns it: the person decides. */
  | { readonly ok: true; readonly approval: WorktreeRecord }
  | Failure

export type Closed =
  | {
      readonly ok: true
      readonly path: string
      readonly branch: string
      /** The ref the uncommitted work was kept at, where there was any. */
      readonly kept?: string
      /** The ref HEAD was kept at, where only a detached HEAD or a stopped rebase reached it. */
      readonly keptHead?: string
      readonly branchDeleted: boolean
      /** Nothing was there to close: the worktree was no longer tracked. */
      readonly already?: true
    }
  | Failure
  | Holding

/** Origin's remote-tracking ref of a branch. */
const originRef = (branch: string): string => `refs/remotes/origin/${branch}`

/** A path made safe as one folder name: letters, digits, dots, dashes and underscores. */
export const folderName = (text: string): string =>
  text
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)

/** How long a new worktree waits for the remote's main before it starts from the one it has. */
const freshMainMs = 5000

/** The repository's main as a local branch's name: `main` for `origin/main`. */
const mainName = async (folder: string): Promise<string | undefined> =>
  (await mainBranch(folder))?.name.replace(/^origin\//, "")

/**
 * The branch a `from` spells, by its short name: `x` for `x`, `origin/x`, `refs/heads/x` or
 * `refs/remotes/origin/x`, where that branch is there; undefined for anything else (a commit, a
 * tag, `HEAD`, `@{-1}`, another remote's branch), which names no home by itself (`HEAD` is
 * read as the checkout's branch by `chosenHome`).
 */
const branchNamed = async (folder: string, from: string): Promise<string | undefined> => {
  const name = from.replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, "")
  if (name === "" || name === "HEAD" || !(await validBranch(folder, name))) return undefined
  const there =
    (await branchTip(folder, name)) !== undefined ||
    (await commitAt(folder, `refs/remotes/origin/${name}`)) !== undefined
  return there ? name : undefined
}

/**
 * A worktree's home, the branch its work belongs on, where it is told or was set: its branch's
 * `novadeckHome` key, else the repository's main by its local name. See checkouts/home.ts.
 */
export const homeSaid = async (folder: string, branch: string): Promise<string | undefined> =>
  (await keysOfBranch(folder, branch)).home ?? (await mainName(folder))

/**
 * The git worktrees agents work in: who owns each, and how they are made, taken, given and
 * closed. Only agents move ownership; nothing here watches git for worktrees made another way.
 * Every operation that reads or changes a row or a worktree runs after the ones before it.
 */
export class Worktrees {
  private chain: Promise<unknown> = Promise.resolve()
  private readonly cleanup: Cleanup
  private readonly madeListeners = new Set<(made: Made) => void>()
  private readonly changeListeners = new Set<(change: WorktreeChange) => void>()

  /** The folder the worktrees live in. */
  get root(): string {
    return this.host.root ?? worktreesRoot()
  }

  constructor(
    private readonly records: WorktreeRecords,
    private readonly host: WorktreesHost,
  ) {
    this.cleanup = new Cleanup(this, {
      owner: host.owner ?? ((id) => (host.exists(id) ? "open" : "gone")),
      ...(host.busy && { busy: host.busy }),
      ...(host.now && { now: host.now }),
      ...(host.hooksFolder !== undefined && { hooksFolder: host.hooksFolder }),
      ...(host.repositories && { repositories: host.repositories }),
      ...host.cleanup,
    })
  }

  /**
   * Calls `listener` each time a worktree starts being tracked (one made by `open`, or adopted
   * by `take`, once its row stands), not when one changes hands. Returns what stops it.
   */
  onMade(listener: (made: Made) => void): () => void {
    this.madeListeners.add(listener)
    return () => {
      this.madeListeners.delete(listener)
    }
  }

  private made(made: Made): void {
    for (const listener of this.madeListeners) listener(made)
  }

  /**
   * Calls `listener` each time a tracked worktree changes hands (a restore from History too,
   * whose terminal comes back under a new id) or stops being tracked, once its row says so.
   * Returns what stops it.
   */
  onChanged(listener: (change: WorktreeChange) => void): () => void {
    this.changeListeners.add(listener)
    return () => {
      this.changeListeners.delete(listener)
    }
  }

  private changed(change: WorktreeChange): void {
    for (const listener of this.changeListeners) listener(change)
  }

  /** Moves the row at `path` to `to`, and says so when it moved. */
  private moveOwner(path: string, from: string | null, to: string): boolean {
    const moved = this.records.setWorktreeOwner(path, to)
    if (moved && from !== to) this.changed({ type: "moved", root: path, from, to })
    return moved
  }

  /** Drops the row at `path`, and says so when there was one. */
  private forget(path: string): void {
    if (this.records.removeWorktree(path)) this.changed({ type: "removed", root: path })
  }

  /** Starts removing the worktrees nobody needs, and fetching their repositories' origins. */
  start(): void {
    this.cleanup.start()
  }

  /** Stops that, and waits for a removal under way. */
  stop(): Promise<void> {
    return this.cleanup.stop()
  }

  /** A terminal was closed: its merged worktrees are looked at now. */
  ownerClosed(): void {
    this.cleanup.closed()
  }

  /** Terminals left History for good: see `Cleanup.pruned`. */
  ownersPruned(terminalIds: readonly string[]): Promise<void> {
    return this.cleanup.pruned(terminalIds)
  }

  /** When the repository's origin was last fetched, in epoch milliseconds; undefined if never. */
  fetchedAt(commonDir: string): number | undefined {
    return this.cleanup.fetchedAt(commonDir)
  }

  /** Makes a repository's remote refs current for a caller that can't wait (`Cleanup.fetchBriefly`). */
  fetchBriefly(commonDir: string, ms: number, follow = true): Promise<void> {
    return this.cleanup.fetchBriefly(commonDir, ms, follow)
  }

  /** When a repository was last fetched and why its last fetch failed (`Cleanup.originStatus`). */
  originStatus(commonDir: string): { fetchedAt?: number; failed?: string } {
    return this.cleanup.originStatus(commonDir)
  }

  /** How many times the repository's checkout was moved to its main since the runner began. */
  moved(commonDir: string): number {
    return this.cleanup.moved(commonDir)
  }

  /** Moves the repository's checkout to its main on the person's say (`Cleanup.update`). */
  update(commonDir: string): ReturnType<Cleanup["update"]> {
    return this.cleanup.update(commonDir)
  }

  /** Fetches the repositories' origins now, and waits for that (`Cleanup.fetchNow`). */
  fetchNow(commonDirs: Iterable<string>): Promise<void> {
    return this.cleanup.fetchNow(commonDirs)
  }

  /** Looks at every worktree for cleanup and waits for that (tests; `start` does it on a timer). */
  tidy(fetch = false): Promise<void> {
    return this.cleanup.look(fetch)
  }

  /**
   * A restore from History was confirmed: the terminal it made, `to`, owns what `from` did.
   * In the queue, so a look at the worktrees sees the new owner or the old row, never neither.
   */
  ownerRestored(from: string, to: string): Promise<void> {
    return this.serial(async () => {
      for (const row of this.records.worktreesOfTerminal(from)) this.moveOwner(row.path, from, to)
    })
  }

  /** Leaves a worktree with no owner, if `terminalId` still owns it. */
  orphanIf(path: string, terminalId: string): Promise<void> {
    return this.serial(async () => {
      if (this.records.worktree(path)?.terminalId === terminalId) this.records.orphanWorktree(path)
    })
  }

  /** Runs `work` after the ones before, so two calls never meet in one worktree or repository. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Every tracked worktree, oldest first. */
  all(): readonly WorktreeRecord[] {
    return this.records.worktrees()
  }

  /** The worktrees a terminal owns, oldest first. */
  ownedRows(terminalId: string): readonly WorktreeRecord[] {
    return this.records.worktreesOfTerminal(terminalId)
  }

  /** The tracked worktree whose folder is `path`, as recorded (its real path). */
  at(path: string): WorktreeRecord | undefined {
    return this.records.worktree(path)
  }

  /** Whether a terminal that owned a worktree is gone, live or in History. */
  private gone(terminalId: string | null): boolean {
    return terminalId === null || !this.host.exists(terminalId)
  }

  /**
   * The top folder of the worktree a path is in, as a real path, which is how rows are keyed:
   * a path inside a worktree names it. Where git can't tell (the folder is gone), the path itself.
   */
  private async topOf(cwd: string, path: string): Promise<string> {
    const resolved = resolve(cwd, path)
    const found = await repositoryAt(resolved)
    return found.ok ? found.repository.top : await realpath(resolved).catch(() => resolved)
  }

  /**
   * Makes a worktree for the terminal: a new branch from `from` (when omitted, origin's branch of
   * that name, tracking it, where origin has one; else the remote's main if the checkout is on a
   * main that is behind it, else the checkout's HEAD), or an existing branch checked out. `cwd` is
   * where the terminal is; `repo` a folder in the repository, absolute or relative to it.
   */
  open(input: {
    readonly projectId: string
    readonly terminalId: string
    readonly cwd: string
    readonly repo?: string | undefined
    readonly branch: string
    readonly from?: string | undefined
    readonly group?: string | undefined
    /** The branch its work belongs on, here or on origin; see `chosenHome`. */
    readonly home?: string | undefined
  }): Promise<Opened | Failure> {
    // Origin's refs are made current, and asked about, before the queue, which every
    // repository's operations wait in.
    return this.fresh(input).then((origin) => this.serial(() => this.opening(input, origin)))
  }

  // A new branch with no `from` starts from origin's branch of that name, or from the remote's main
  // when the checkout is on main: both fetched for a moment at most, as a slow or failing remote
  // leaves the cached refs and the fetch carries on meanwhile. A fetch prunes nothing, so where
  // origin's branch is cached, origin is asked whether it still has it, as briefly. What origin
  // has of the branch, where it was cached; undefined where it wasn't, or a local branch exists.
  private async fresh(input: Parameters<Worktrees["open"]>[0]): Promise<OriginBranch | undefined> {
    if (input.from !== undefined) return undefined
    try {
      const folder = resolve(input.cwd, input.repo ?? ".")
      const found = await repositoryAt(folder)
      if (!found.ok) return undefined
      const { home, commonDir } = found.repository
      // A name git refuses is refused in the queue, with nothing fetched or asked for it.
      if (!(await validBranch(home, input.branch))) return undefined
      if ((await branchTip(home, input.branch)) !== undefined) return undefined
      const ms = this.host.freshMainMs ?? freshMainMs
      await this.cleanup.fetchBriefly(commonDir, ms)
      if ((await commitAt(home, originRef(input.branch))) === undefined) return undefined
      const has = await this.cleanup.remoteHas(commonDir, input.branch, ms)
      return has === undefined ? "unchecked" : has ? "current" : "gone"
    } catch {
      // The cached refs stand.
      return undefined
    }
  }

  private async opening(
    input: Parameters<Worktrees["open"]>[0],
    origin: OriginBranch | undefined,
  ): Promise<Opened | Failure> {
    const folder = resolve(input.cwd, input.repo ?? ".")
    const found = await repositoryAt(folder)
    if (!found.ok) return found
    const { repository } = found
    if (!(await validBranch(repository.home, input.branch)))
      return refused(`"${input.branch}" isn't a branch name git accepts.`)
    const group = folderName(input.group ?? input.branch) || "work"
    const wanted = join(this.root, input.projectId, group, repository.name)
    const tracked = this.records.worktree(wanted)
    if (tracked || existsSync(wanted))
      return refused(
        tracked && tracked.commonDir !== repository.commonDir
          ? `Another repository named ${repository.name} is already in the group ${group}; pick another group.`
          : `There is already a worktree of ${repository.name} in the group ${group}, at ${wanted}; ` +
              "pick another group, or take_worktree it.",
      )
    const tip = await branchTip(repository.home, input.branch)
    if (tip !== undefined && input.from !== undefined)
      return refused(
        `${input.branch} exists already, so it is checked out as it is: leave from out.`,
      )
    // Left out, it starts from origin's branch of that name where origin has it (or couldn't say),
    // else from main when the checkout sits on a stale local main, else from HEAD. Read again
    // here, as a fetch may have moved it.
    const remote =
      tip === undefined && input.from === undefined && origin !== undefined && origin !== "gone"
        ? await commitAt(repository.home, originRef(input.branch))
        : undefined
    const behind =
      input.from === undefined && remote === undefined ? await behindMain(folder) : undefined
    const start = input.from ?? remote ?? behind?.commit ?? "HEAD"
    // From the folder's own HEAD, its commit and branch are read in one git call, so they can't
    // disagree: that branch is where the work builds on (as in a lead's worktree, for the agents
    // it opens); a detached HEAD has none.
    const head = tip === undefined && start === "HEAD" ? await headOf(folder) : undefined
    const base = tip ?? head?.commit ?? (await commitAt(folder, start))
    if (base === undefined) return refused(`${start} isn't a commit in ${repository.name}.`)
    const startedOn = head?.branch
    const home = await this.chosenHome(
      repository.home,
      input.branch,
      input.home,
      input.from,
      startedOn,
    )
    if (!home.ok) return home
    await mkdir(join(wanted, ".."), { recursive: true })
    const real = join(await realpath(join(wanted, "..")), repository.name)
    // The row first: a crash between the two leaves a row whose folder never appeared, which
    // the next start drops, never a worktree nobody tracks.
    try {
      this.records.insertWorktree({
        path: real,
        commonDir: repository.commonDir,
        branch: input.branch,
        base,
        projectId: input.projectId,
        terminalId: input.terminalId,
        adopted: false,
        branchMade: tip === undefined,
        createdAt: (this.host.now ?? Date.now)(),
      })
    } catch {
      return refused("Novadeck couldn't record the worktree: its project is gone.")
    }
    const added = await addWorktree(
      repository.home,
      real,
      input.branch,
      tip === undefined ? { create: true, from: base } : { create: false },
      this.host.platform,
    )
    if (!added.ok) {
      this.records.removeWorktree(real)
      // A branch git made before it failed is ours to take back.
      if (tip === undefined && (await branchTip(repository.home, input.branch)) !== undefined)
        await deleteBranch(repository.home, input.branch)
      return refused(`git couldn't make the worktree: ${said(added)}.`)
    }
    const tracking =
      remote === undefined
        ? undefined
        : await setUpstream(repository.home, input.branch, originRef(input.branch))
    // A new branch's keys are all its own: one a deleted branch of that name left goes.
    // An existing one keeps what it has, its home changed only when given.
    const kept = tip === undefined ? {} : await keysOfBranch(real, input.branch)
    await this.keyed(
      real,
      input.branch,
      tip === undefined
        ? { base, made: true, home: home.write ?? null }
        : {
            ...(kept.base === undefined && { base }),
            ...(input.home !== undefined && { home: home.write ?? null }),
          },
    )
    this.made({ root: real, projectId: input.projectId })
    return {
      ok: true,
      path: real,
      branch: input.branch,
      existing: tip !== undefined,
      base,
      // Said only where it decided the start: origin's branch was taken, or passed over as gone.
      ...(origin !== undefined &&
        (remote !== undefined || (tip === undefined && origin === "gone")) && { origin }),
      ...(tracking !== undefined && { tracking }),
      instructions: instructionFiles
        .map((name) => join(real, name))
        .filter((file) => existsSync(file)),
      ...(await this.homeOf(real, input.branch)),
    }
  }

  /**
   * The home a worktree is given: `home` where named (a branch here, or origin's as `origin/x`
   * or `x`), else the branch `from` names, else the branch it starts from (`startedOn`: the
   * checkout's own branch, where it started from that checkout's HEAD, which `from: HEAD` is
   * too), else none: it stays the repository's main (a detached HEAD, a tag or commit, origin's
   * branch of its name, an existing branch). `write` is what the branch's key holds: nothing
   * where home is the repository's main, which is measured by as ever without a key.
   */
  private async chosenHome(
    folder: string,
    branch: string,
    home: string | undefined,
    from: string | undefined,
    startedOn?: string,
  ): Promise<{ readonly ok: true; readonly write?: string } | Failure> {
    const named =
      home !== undefined
        ? home.replace(/^(?:refs\/heads\/|refs\/remotes\/origin\/|origin\/)/, "")
        : from !== undefined && from !== "HEAD"
          ? await branchNamed(folder, from)
          : startedOn
    if (named === undefined) return { ok: true }
    if (named === branch) return refused("A worktree's home is another branch than its own.")
    const there =
      (await branchTip(folder, named)) !== undefined ||
      (await commitAt(folder, originRef(named))) !== undefined
    if (!there) return refused(`${home ?? named} isn't a branch here or on origin.`)
    return named === (await mainName(folder)) ? { ok: true } : { ok: true, write: named }
  }

  /** Sets a branch's keys, logging a write git refused: an open or take never fails on one. */
  private async keyed(
    folder: string,
    branch: string,
    keys: Parameters<typeof writeKeys>[2],
  ): Promise<void> {
    if (Object.keys(keys).length === 0) return
    if (!(await writeKeys(folder, branch, keys)))
      log.warn("worktrees.keys-failed", "Novadeck couldn't write a worktree's keys to git config", {
        data: { path: folder, branch },
      })
  }

  /** `{ home }` as said in an answer, or nothing where there is none to say. */
  private async homeOf(folder: string, branch: string): Promise<{ readonly home?: string }> {
    const home = await homeSaid(folder, branch)
    return home === undefined ? {} : { home }
  }

  /**
   * Makes the worktree at `path` (or the one it is in) the terminal's: at once where it has
   * no owner, or its owner is gone; one git lists but Novadeck never made is recorded as
   * adopted, if it is of the project's repositories and not locked. Another live terminal's
   * is returned for the person to approve (`transfer` then moves it).
   */
  take(input: {
    readonly projectId: string
    readonly terminalId: string
    readonly cwd: string
    readonly path: string
    /** Sets its home (see `chosenHome`), once it is the caller's by this call. */
    readonly home?: string | undefined
  }): Promise<Taken> {
    return this.serial(() => this.taking(input))
  }

  /** Whether a repository is the caller's or the project's, or is inside the project's folder. */
  private async ofProject(
    projectId: string,
    cwd: string,
    repository: { readonly commonDir: string; readonly home: string },
  ): Promise<boolean> {
    const same = async (folder: string): Promise<boolean> => {
      const found = await repositoryAt(folder)
      return found.ok && found.repository.commonDir === repository.commonDir
    }
    if (await same(cwd)) return true
    const folder = this.host.projectFolder?.(projectId)
    if (folder === undefined) return false
    if (await same(folder)) return true
    const inside = await realpath(folder).catch(() => folder)
    return repository.home.startsWith(inside.endsWith(sep) ? inside : inside + sep)
  }

  private async taking(input: Parameters<Worktrees["take"]>[0]): Promise<Taken> {
    const top = await this.topOf(input.cwd, input.path)
    const row = this.records.worktree(top)
    if (row) {
      if (row.projectId !== input.projectId)
        return refused("That worktree belongs to another project.")
      const mine = row.terminalId === input.terminalId
      if (!mine && !this.gone(row.terminalId)) return { ok: true, approval: row }
      const homed = await this.rehomed(row.path, row.branch, input.home)
      if (!homed.ok) return homed
      if (!mine) this.moveOwner(row.path, row.terminalId, input.terminalId)
      return {
        ok: true,
        path: row.path,
        branch: row.branch,
        ...(mine && { already: true as const }),
        ...(await this.homeOf(row.path, row.branch)),
      }
    }
    const found = await repositoryAt(top)
    if (!found.ok) return found
    const { repository } = found
    if (!(await this.ofProject(input.projectId, input.cwd, repository)))
      return refused(
        "That worktree is of a repository outside this project, so Novadeck won't adopt it.",
      )
    const entries = await entriesOf(repository.home)
    if (entries === undefined) return refused("Novadeck couldn't list the repository's worktrees.")
    const real = repository.top
    // The first listed is the main checkout, which is no worktree to take.
    const entry = (
      await Promise.all(
        entries.map(async (each) => ({
          each,
          real: await realpath(each.path).catch(() => each.path),
        })),
      )
    ).find((one, index) => index > 0 && one.real === real)?.each
    if (!entry)
      return refused(
        `${real} isn't a linked worktree: git lists it as the repository's own checkout, or not at all.`,
      )
    if (entry.locked) return refused("That worktree is locked in git, so Novadeck won't take it.")
    if (entry.branch === null)
      return refused("That worktree has a detached HEAD, with no branch to track.")
    const homed = await this.chosenHome(real, entry.branch, input.home, undefined)
    if (!homed.ok) return homed
    const base = await startOf(real)
    try {
      this.records.insertWorktree({
        path: real,
        commonDir: repository.commonDir,
        branch: entry.branch,
        base,
        projectId: input.projectId,
        terminalId: input.terminalId,
        adopted: true,
        branchMade: false,
        createdAt: (this.host.now ?? Date.now)(),
      })
    } catch {
      return refused(
        this.records.worktree(real)
          ? "That worktree is tracked already."
          : "Novadeck couldn't record the worktree: its project is gone.",
      )
    }
    // What a script that made it set stands, home included, unless home is given.
    const kept = await keysOfBranch(real, entry.branch)
    await this.keyed(real, entry.branch, {
      ...(kept.base === undefined && { base }),
      ...(input.home !== undefined && { home: homed.write ?? null }),
    })
    this.made({ root: real, projectId: input.projectId })
    return {
      ok: true,
      path: real,
      branch: entry.branch,
      ...(await this.homeOf(real, entry.branch)),
    }
  }

  /** Sets a tracked worktree's home where `home` is given; why not, where it can't be. */
  private async rehomed(
    path: string,
    branch: string,
    home: string | undefined,
  ): Promise<{ readonly ok: true } | Failure> {
    if (home === undefined) return { ok: true }
    if (!existsSync(path)) return refused("That worktree's folder is gone, so its home stays.")
    const live = await currentBranch(path)
    if (live !== branch)
      return refused(
        `That worktree is on ${live ?? "a detached HEAD"} now, not ${branch}, so its home stays.`,
      )
    const chosen = await this.chosenHome(path, branch, home, undefined)
    if (!chosen.ok) return chosen
    await this.keyed(path, branch, { home: chosen.write ?? null })
    return { ok: true }
  }

  /**
   * Moves a worktree to `to`, once the person approved: only if it is still `from`'s (or no
   * one's), as the approval was asked about. False when it changed meanwhile.
   */
  transfer(path: string, from: string, to: string): Promise<boolean> {
    return this.serial(async () => {
      const row = this.records.worktree(path)
      if (!row || (row.terminalId !== from && !this.gone(row.terminalId))) return false
      return this.moveOwner(path, row.terminalId, to)
    })
  }

  /** The caller's worktree at (or containing) `path`, or why it isn't one. Run in the queue. */
  private async ownedBy(
    terminalId: string,
    cwd: string,
    path: string,
  ): Promise<{ readonly ok: true; readonly row: WorktreeRecord } | Failure> {
    const row = this.records.worktree(await this.topOf(cwd, path))
    if (!row)
      return refused(
        "Novadeck doesn't track a worktree there: open_worktree or take_worktree makes one.",
      )
    if (row.terminalId !== terminalId)
      return refused(
        this.gone(row.terminalId)
          ? "That worktree has no owner: take_worktree it first."
          : "That worktree is another terminal's: only its owner may do that.",
      )
    return { ok: true, row }
  }

  /** Gives the caller's worktree to another terminal, which must exist. */
  give(input: {
    readonly terminalId: string
    readonly cwd: string
    readonly path: string
    readonly to: string
  }): Promise<{ readonly ok: true; readonly row: WorktreeRecord } | Failure> {
    return this.serial(async () => {
      const owned = await this.ownedBy(input.terminalId, input.cwd, input.path)
      if (!owned.ok) return owned
      if (!this.host.exists(input.to)) return refused("That terminal is gone.")
      this.moveOwner(owned.row.path, input.terminalId, input.to)
      return owned
    })
  }

  /**
   * Closes the caller's worktree: refused while it holds uncommitted or untracked files, or
   * commits its home doesn't have, unless `force`, which keeps what can be kept on
   * refs first. Ownership is checked in the queue, just before the removal.
   */
  closeOwned(input: {
    readonly terminalId: string
    readonly cwd: string
    readonly path: string
    readonly force: boolean
  }): Promise<Closed> {
    return this.serial(async () => {
      const owned = await this.ownedBy(input.terminalId, input.cwd, input.path)
      return owned.ok ? this.removal(owned.row, input.force) : owned
    })
  }

  /**
   * Closes the worktree at `path` on the person's say, whoever owns it. The row is looked up
   * in the queue, so a take, give or close that ran before is seen; one no longer tracked
   * is `already` closed. `guard` runs there too, just before the removal: its answer is why
   * the worktree must stay now (an agent works in it).
   */
  closeAt(
    path: string,
    force: boolean,
    guard?: (row: WorktreeRecord) => Promise<string | undefined>,
    /** Its work lives elsewhere too (merged, or its pull request closed): what main lacks is no reason to refuse. */
    safe = false,
  ): Promise<Closed> {
    return this.serial(async () => {
      const row = this.records.worktree(path)
      if (!row) return { ok: true, path, branch: "", branchDeleted: false, already: true }
      const why = await guard?.(row)
      return why === undefined ? this.removal(row, force, safe) : refused(why)
    })
  }

  /** Removes a worktree whoever owns it (cleanup's entry; see `removal`). */
  remove(row: WorktreeRecord, force: boolean): Promise<Closed> {
    return this.serial(() => this.removal(row, force))
  }

  /**
   * Removes a worktree for good: what git couldn't read is never removed, uncommitted work
   * and commits only HEAD reaches are kept on `refs/novadeck/kept/` first, the folder goes,
   * the branch goes only when Novadeck made it and the main branch holds all of it, and the
   * row goes last. Without `force` it refuses a worktree that holds anything the main branch
   * doesn't, unless it is `safe` (see `closeAt`). Ignored files (such as .env or data) are not kept.
   * One with submodules, or with an untracked git repository of its own inside that holds work
   * (`nestedWork`), which no ref can keep, is never removed, forced or not. Run in the queue.
   */
  private async removal(row: WorktreeRecord, force: boolean, safe = false): Promise<Closed> {
    const home = homeOf(row.commonDir)
    const finish = (extra: { kept?: string; keptHead?: string; branchDeleted?: boolean } = {}) => {
      this.forget(row.path)
      return {
        ok: true,
        path: row.path,
        branch: row.branch,
        branchDeleted: false,
        ...extra,
      } as const
    }
    if (!existsSync(row.path)) {
      await forgetEntry(row.commonDir, row.path)
      return finish()
    }
    const standing = await standingOf(row.path)
    if (!standing.readable)
      return refused(
        `Novadeck couldn't read what the worktree holds (${standing.why}), so it stays, even ` +
          "with force. Commit or clean up, or ask the user.",
      )
    const submodules = await hasSubmodules(row.path)
    if (submodules !== false)
      return refused(
        submodules === undefined
          ? "Novadeck couldn't tell whether the worktree has submodules, so it stays."
          : "The worktree has submodules checked out, whose commits Novadeck can't keep, so it " +
              "stays: close it yourself or ask the user.",
      )
    const dirty = standing.dirty > 0
    // A repository of its own inside, untracked, which no ref can keep but as a gitlink: it goes
    // only where it holds nothing a remote lacks. A clean worktree has none.
    const nested = dirty ? await nestedRepositories(row.path) : []
    if (nested === undefined)
      return refused(
        "Novadeck couldn't tell whether the worktree holds a git repository of its own, so it stays.",
      )
    for (const each of nested) {
      // eslint-disable-next-line no-await-in-loop -- One repository at a time.
      const work = await nestedWork(join(row.path, each))
      if (work !== undefined)
        return refused(
          `The worktree holds a git repository of its own, not tracked, at ${each}, with ${work}: ` +
            "Novadeck can't keep its files and commits, so the worktree stays, even with force.",
        )
    }
    // A safe one's commits are merged or kept on its remote: main lacking them asks nothing.
    // What it holds uncommitted still does, as it may have changed since it was read safe.
    const unmerged = !standing.inMain && !safe
    if ((dirty || unmerged) && !force) {
      const parts = [
        ...(dirty
          ? [`${standing.dirty} uncommitted or untracked path${standing.dirty === 1 ? "" : "s"}`]
          : []),
        ...(unmerged
          ? [
              standing.ahead === null
                ? `commits ${standing.home ?? "the main branch"} may not have`
                : `${standing.ahead} commit${standing.ahead === 1 ? "" : "s"} ${standing.home ?? "the main branch"} doesn't have`,
            ]
          : []),
      ]
      const holds = parts.join(" and ")
      return {
        ok: false,
        holds,
        reason:
          `The worktree holds ${holds}, so it stays. To close it anyway, call ` +
          "close_worktree with force: uncommitted files are kept on a ref (ignored files, such " +
          "as .env or data, are not), and a branch with commits stays.",
      }
    }
    const stray = await keepStrayHead(row.path, row.branch, standing.holders)
    if (stray === null)
      return refused(
        "Novadeck couldn't keep the commits HEAD alone reaches, so the worktree stays.",
      )
    let kept: string | undefined
    if (dirty) {
      kept = await keepWork(row.path, row.branch)
      if (kept === undefined)
        return refused("Novadeck couldn't keep the uncommitted files, so the worktree stays.")
    }
    const removed = await removeFolder(home, row.path, force)
    if (!removed.ok && existsSync(row.path) && !(await finishRemoval(home, row.path)))
      return refused(`git couldn't remove the worktree: ${said(removed)}.`)
    let branchDeleted = false
    const { holders } = standing
    const tip = await branchTip(home, row.branch)
    if (
      row.branchMade &&
      holders.length > 0 &&
      tip !== undefined &&
      !holders.some((each) => each.name === row.branch) &&
      (await heldByAny(home, tip, holders))
    )
      branchDeleted = await deleteBranch(home, row.branch)
    return finish({
      ...(kept !== undefined && { kept }),
      ...(stray !== undefined && { keptHead: stray }),
      branchDeleted,
    })
  }

  /**
   * Removes all of a project's worktrees, keeping what isn't safe elsewhere, before its rows
   * go. One git couldn't read, or that has submodules or an untracked git repository of its own
   * holding work, stays on disk (its row goes with the project), and is logged.
   */
  removeProject(projectId: string): Promise<void> {
    return this.serial(async () => {
      for (const row of this.records.worktreesOfProject(projectId)) {
        // eslint-disable-next-line no-await-in-loop -- One git run at a time.
        const closed = await this.removal(row, true).catch((error: unknown) =>
          refused(String(error)),
        )
        if (!closed.ok)
          log.warn("worktrees.project-removal", "A worktree of a removed project stayed on disk", {
            data: { path: row.path, reason: closed.reason },
          })
      }
    })
  }

  /**
   * Checks every row against the disk and the terminals, at the runner's start: a folder gone
   * (or never made, as a crash left it) is forgotten by its repository, its own entry only,
   * and its row dropped, and an owner that is gone leaves the worktree with no owner. Each
   * step stands alone, so a crash midway finishes next start.
   */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      for (const row of this.records.worktrees()) {
        if (!existsSync(row.path)) {
          // eslint-disable-next-line no-await-in-loop -- One at a time.
          await forgetEntry(row.commonDir, row.path)
          this.forget(row.path)
        } else {
          if (row.terminalId !== null && !this.host.exists(row.terminalId))
            this.records.orphanWorktree(row.path)
          // eslint-disable-next-line no-await-in-loop -- One at a time.
          await this.carried(row)
        }
      }
    })
  }

  /**
   * Carries a row's start commit, and whether Novadeck made its branch, into its branch's keys
   * in git config, where they aren't yet: only while the branch checked out there is the row's,
   * so a name reused since is never marked. Nothing where git can't be read; the next start
   * tries again. See architecture/worktree-home.md in the workspace.
   */
  private async carried(row: WorktreeRecord): Promise<void> {
    if ((await currentBranch(row.path)) !== row.branch) return
    const kept = await keysOfBranch(row.path, row.branch)
    if (kept.base !== undefined) return
    await this.keyed(row.path, row.branch, {
      base: row.base,
      ...(row.branchMade && { made: true }),
    })
  }
}
