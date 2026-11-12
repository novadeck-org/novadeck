import { existsSync } from "node:fs"
import { mkdir, realpath } from "node:fs/promises"
import { join, resolve } from "node:path"

import { logs } from "../log.js"
import type { WorktreeRecord, WorktreeRecords } from "./records.js"
import {
  addWorktree,
  branchTip,
  commitAt,
  deleteBranch,
  entriesOf,
  heldByMain,
  homeOf,
  keepWork,
  prune,
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

  /** The tracked worktree at a folder, found by its real path. */
  private async tracked(path: string): Promise<WorktreeRecord | undefined> {
    return this.records.worktree(await realpath(path).catch(() => path))
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
    const path = join(this.host.root ?? worktreesRoot(), input.projectId, group, repository.name)
    const tracked = this.records.worktree(path)
    if (tracked || existsSync(path))
      return refused(
        tracked && tracked.commonDir !== repository.commonDir
          ? `Another repository named ${repository.name} is already in the group ${group}; pick another group.`
          : `There is already a worktree of ${repository.name} in the group ${group}, at ${path}; ` +
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
    await mkdir(join(path, ".."), { recursive: true })
    const added = await addWorktree(
      repository.home,
      path,
      input.branch,
      tip === undefined ? { create: true, from: base } : { create: false },
      this.host.platform,
    )
    if (!added.ok) return refused(`git couldn't make the worktree: ${said(added)}.`)
    const real = await realpath(path).catch(() => path)
    try {
      this.records.insertWorktree({
        path: real,
        commonDir: repository.commonDir,
        branch: input.branch,
        base,
        projectId: input.projectId,
        terminalId: input.terminalId,
        adopted: false,
        diverged: false,
        createdAt: (this.host.now ?? Date.now)(),
      })
    } catch {
      // The project went meanwhile: nothing keeps the folder, so it goes.
      await removeFolder(repository.home, real)
      return refused("Novadeck couldn't record the worktree: its project is gone.")
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
   * Makes the worktree at `path` the terminal's: at once where it has no owner, or its owner
   * is gone; one git lists but Novadeck never made is recorded as adopted. Another live
   * terminal's is returned for the person to approve (`transfer` then moves it).
   */
  take(input: {
    readonly projectId: string
    readonly terminalId: string
    readonly cwd: string
    readonly path: string
  }): Promise<Taken> {
    return this.serial(() => this.taking(input))
  }

  private async taking(input: Parameters<Worktrees["take"]>[0]): Promise<Taken> {
    const asked = resolve(input.cwd, input.path)
    const row = await this.tracked(asked)
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
    const found = await repositoryAt(asked)
    if (!found.ok) return refused(`${asked} isn't a git worktree.`)
    const { repository } = found
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
    if (entry.branch === null)
      return refused("That worktree has a detached HEAD, with no branch to track.")
    this.records.insertWorktree({
      path: real,
      commonDir: repository.commonDir,
      branch: entry.branch,
      base: await startOf(real),
      projectId: input.projectId,
      terminalId: input.terminalId,
      adopted: true,
      diverged: false,
      createdAt: (this.host.now ?? Date.now)(),
    })
    return { ok: true, path: real, branch: entry.branch }
  }

  /**
   * Moves a worktree to `to`, once the person approved: only if it is still `from`'s (or no
   * one's), as the approval was asked about. False when it changed meanwhile.
   */
  transfer(path: string, from: string, to: string): boolean {
    const row = this.records.worktree(path)
    if (!row || (row.terminalId !== from && !this.gone(row.terminalId))) return false
    return this.records.setWorktreeOwner(path, to)
  }

  /** The caller's worktree at `path`, or why it isn't one. */
  async owned(
    terminalId: string,
    cwd: string,
    path: string,
  ): Promise<{ readonly ok: true; readonly row: WorktreeRecord } | Failure> {
    const row = await this.tracked(resolve(cwd, path))
    if (!row)
      return refused(
        "Novadeck doesn't track a worktree there: open_worktree or take_worktree makes one.",
      )
    if (row.terminalId !== terminalId)
      return refused(
        row.terminalId === null || this.gone(row.terminalId)
          ? "That worktree has no owner: take_worktree it first."
          : "That worktree is another terminal's: only its owner may do that.",
      )
    return { ok: true, row }
  }

  /**
   * Closes the caller's worktree: refused while it holds uncommitted or untracked files, or
   * commits the main branch doesn't have, unless `force`, which keeps the files at a ref first.
   */
  close(row: WorktreeRecord, force: boolean): Promise<Closed> {
    return this.serial(() => this.removal(row, force))
  }

  /**
   * Removes a worktree for good, whoever owns it: its uncommitted work is kept at
   * `refs/novadeck/kept/<branch>` first, the folder goes, the branch goes only when the main
   * branch holds all of it, and the row goes last. Without `force` it refuses a worktree that
   * holds anything the main branch doesn't. This is the one removal, for closing, for the
   * project going and for cleanup.
   */
  async removal(row: WorktreeRecord, force: boolean): Promise<Closed> {
    const home = homeOf(row.commonDir)
    const finish = (extra: { kept?: string; branchDeleted?: boolean } = {}): Closed => {
      this.records.removeWorktree(row.path)
      return { ok: true, path: row.path, branch: row.branch, branchDeleted: false, ...extra }
    }
    if (!existsSync(row.path)) {
      await prune(home)
      return finish()
    }
    const standing = await standingOf(row.path)
    const dirty = standing.dirty > 0
    const unmerged = !standing.inMain
    if ((dirty || unmerged) && !force) {
      const parts = [
        ...(dirty
          ? [`${standing.dirty} uncommitted or untracked file${standing.dirty === 1 ? "" : "s"}`]
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
          "close_worktree with force: uncommitted files are kept on a ref, and a branch with " +
          "commits stays.",
      )
    }
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
      main &&
      tip !== undefined &&
      row.branch !== main.name &&
      (await heldByMain(home, tip, main))
    )
      branchDeleted = await deleteBranch(home, row.branch)
    return finish({ ...(kept !== undefined && { kept }), branchDeleted })
  }

  /** Removes all of a project's worktrees, keeping what isn't safe elsewhere, before its rows go. */
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
   * is pruned from its repository and its row dropped, and an owner that is gone leaves the
   * worktree with no owner. Each step stands alone, so a crash midway finishes next start.
   */
  reconcile(): Promise<void> {
    return this.serial(async () => {
      for (const row of this.records.worktrees()) {
        if (!existsSync(row.path)) {
          // eslint-disable-next-line no-await-in-loop -- One git run at a time.
          if (existsSync(homeOf(row.commonDir))) await prune(homeOf(row.commonDir))
          this.records.removeWorktree(row.path)
        } else if (row.terminalId !== null && !this.host.exists(row.terminalId)) {
          this.records.orphanWorktree(row.path)
        }
      }
    })
  }
}
