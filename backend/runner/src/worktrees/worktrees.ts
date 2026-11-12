import { existsSync } from "node:fs"
import { mkdir, realpath } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

import { logs } from "../log.js"
import type { WorktreeRecord, WorktreeRecords } from "./records.js"
import {
  addWorktree,
  branchTip,
  commitAt,
  deleteBranch,
  entriesOf,
  forgetEntry,
  hasSubmodules,
  heldByMain,
  homeOf,
  keepStrayHead,
  keepWork,
  removeFolder,
  repositoryAt,
  said,
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
}

type Failure = { readonly ok: false; readonly reason: string }
const refused = (reason: string): Failure => ({ ok: false, reason })

/** The instruction files at a worktree's top, which harnesses don't load from an added folder. */
const instructionFiles = ["AGENTS.md", "CLAUDE.md", "GEMINI.md"] as const

export type Opened = {
  readonly ok: true
  readonly path: string
  readonly branch: string
  /** Whether the branch already existed and was checked out. */
  readonly existing: boolean
  readonly base: string
  /** The paths of the instruction files at its top. */
  readonly instructions: readonly string[]
}

export type Taken =
  | { readonly ok: true; readonly path: string; readonly branch: string; readonly already?: true }
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
    }
  | Failure

/** A path made safe as one folder name: letters, digits, dots, dashes and underscores. */
export const folderName = (text: string): string =>
  text
    .replaceAll(/[^A-Za-z0-9._-]+/g, "-")
    .replaceAll(/^[-.]+|[-.]+$/g, "")
    .slice(0, 80)

/**
 * The git worktrees agents work in: who owns each, and how they are made, taken, given and
 * closed. Only agents move ownership; nothing here watches git for worktrees made another way.
 * Every operation that reads or changes a row or a worktree runs after the ones before it.
 */
export class Worktrees {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly records: WorktreeRecords,
    private readonly host: WorktreesHost,
  ) {}

  /** Runs `work` after the ones before, so two calls never meet in one worktree or repository. */
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.chain.then(work, work)
    this.chain = next.catch(() => undefined)
    return next
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
   * Makes a worktree for the terminal: a new branch from `from` (the checkout's HEAD when
   * omitted), or an existing branch checked out. `cwd` is where the terminal is; `repo` a
   * folder in the repository, absolute or relative to it.
   */
  open(input: {
    readonly projectId: string
    readonly terminalId: string
    readonly cwd: string
    readonly repo?: string | undefined
    readonly branch: string
    readonly from?: string | undefined
    readonly group?: string | undefined
  }): Promise<Opened | Failure> {
    return this.serial(() => this.opening(input))
  }

  private async opening(input: Parameters<Worktrees["open"]>[0]): Promise<Opened | Failure> {
    const folder = resolve(input.cwd, input.repo ?? ".")
    const found = await repositoryAt(folder)
    if (!found.ok) return found
    const { repository } = found
    if (!(await validBranch(repository.home, input.branch)))
      return refused(`"${input.branch}" isn't a branch name git accepts.`)
    const group = folderName(input.group ?? input.branch) || "work"
    const wanted = join(this.host.root ?? worktreesRoot(), input.projectId, group, repository.name)
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
    const start = input.from ?? "HEAD"
    const base = tip ?? (await commitAt(folder, start))
    if (base === undefined) return refused(`${start} isn't a commit in ${repository.name}.`)
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
    return {
      ok: true,
      path: real,
      branch: input.branch,
      existing: tip !== undefined,
      base,
      instructions: instructionFiles
        .map((name) => join(real, name))
        .filter((file) => existsSync(file)),
    }
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
      if (row.terminalId === input.terminalId)
        return { ok: true, path: row.path, branch: row.branch, already: true }
      if (this.gone(row.terminalId)) {
        this.records.setWorktreeOwner(row.path, input.terminalId)
        return { ok: true, path: row.path, branch: row.branch }
      }
      return { ok: true, approval: row }
    }
    const found = await repositoryAt(top)
    if (!found.ok) return refused(`${top} isn't a git worktree.`)
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
    try {
      this.records.insertWorktree({
        path: real,
        commonDir: repository.commonDir,
        branch: entry.branch,
        base: await startOf(real),
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
    return { ok: true, path: real, branch: entry.branch }
  }

  /**
   * Moves a worktree to `to`, once the person approved: only if it is still `from`'s (or no
   * one's), as the approval was asked about. False when it changed meanwhile.
   */
  transfer(path: string, from: string, to: string): Promise<boolean> {
    return this.serial(async () => {
      const row = this.records.worktree(path)
      if (!row || (row.terminalId !== from && !this.gone(row.terminalId))) return false
      return this.records.setWorktreeOwner(path, to)
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
      this.records.setWorktreeOwner(owned.row.path, input.to)
      return owned
    })
  }

  /**
   * Closes the caller's worktree: refused while it holds uncommitted or untracked files, or
   * commits the main branch doesn't have, unless `force`, which keeps what can be kept on
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

  /** Removes a worktree whoever owns it (cleanup's entry; see `removal`). */
  remove(row: WorktreeRecord, force: boolean): Promise<Closed> {
    return this.serial(() => this.removal(row, force))
  }

  /**
   * Removes a worktree for good: what git couldn't read is never removed, uncommitted work
   * and commits only HEAD reaches are kept on `refs/novadeck/kept/` first, the folder goes,
   * the branch goes only when Novadeck made it and the main branch holds all of it, and the
   * row goes last. Without `force` it refuses a worktree that holds anything the main branch
   * doesn't. Ignored files (such as .env or data) are not kept. Run in the queue.
   */
  private async removal(row: WorktreeRecord, force: boolean): Promise<Closed> {
    const home = homeOf(row.commonDir)
    const finish = (extra: { kept?: string; keptHead?: string; branchDeleted?: boolean } = {}) => {
      this.records.removeWorktree(row.path)
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
    const unmerged = !standing.inMain
    if ((dirty || unmerged) && !force) {
      const parts = [
        ...(dirty
          ? [`${standing.dirty} uncommitted or untracked path${standing.dirty === 1 ? "" : "s"}`]
          : []),
        ...(unmerged
          ? [
              standing.ahead === null
                ? "commits the main branch may not have"
                : `${standing.ahead} commit${standing.ahead === 1 ? "" : "s"} the main branch doesn't have`,
            ]
          : []),
      ]
      return refused(
        `The worktree holds ${parts.join(" and ")}, so it stays. To close it anyway, call ` +
          "close_worktree with force: uncommitted files are kept on a ref (ignored files, such " +
          "as .env or data, are not), and a branch with commits stays.",
      )
    }
    const stray = await keepStrayHead(row.path, row.branch, standing.main)
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
    const removed = await removeFolder(home, row.path)
    if (!removed.ok && existsSync(row.path))
      return refused(`git couldn't remove the worktree: ${said(removed)}.`)
    let branchDeleted = false
    const { main } = standing
    const tip = await branchTip(home, row.branch)
    if (
      row.branchMade &&
      main &&
      tip !== undefined &&
      row.branch !== main.name &&
      (await heldByMain(home, tip, main))
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
   * go. One git couldn't read, or that has submodules, stays on disk (its row goes with the
   * project), and is logged.
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
          this.records.removeWorktree(row.path)
        } else if (row.terminalId !== null && !this.host.exists(row.terminalId)) {
          this.records.orphanWorktree(row.path)
        }
      }
    })
  }
}
