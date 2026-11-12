import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"

import { git, type Run } from "../checkouts/git.js"
import { commonDir, mainBranch, mergeBase, type Main } from "../checkouts/repository.js"

// Git, run for the worktrees agents open, take and close.

const small = { cap: 64 * 1024 }
const listing = { cap: 4 * 1024 * 1024 }

/** `git worktree add` may check out a big repository: past the helper's usual 5 seconds. */
export const addMs = 60_000

/** What git printed as one trimmed line; undefined when it failed or printed none. */
const line = (run: Run): string | undefined => (run.ok ? run.out.trim() || undefined : undefined)

/** Why a run failed, in a few words an agent can act on. */
export const said = (run: Run): string =>
  run.ok
    ? ""
    : run.kind === "timeout"
      ? "git took too long"
      : run.kind === "no-git"
        ? "git isn't installed here"
        : run.said || "git failed"

/** A repository, as the worktrees of it are told apart. */
export type Repository = {
  /** The top folder of the checkout it was found from, as a real path. */
  readonly top: string
  /** Its git common dir. */
  readonly commonDir: string
  /** The folder a worktree of it is named for: the main checkout's own folder name. */
  readonly name: string
  /** A folder git runs in for the repository itself, never a worktree that may be removed. */
  readonly home: string
}

/** The folder that holds the repository's main checkout, or the bare repository itself. */
export const homeOf = (common: string): string =>
  basename(common) === ".git" ? dirname(common) : common

/**
 * The repository a folder is in, or why it is in none. A folder inside any checkout of it
 * (the main one or a linked worktree) names the same repository.
 */
export const repositoryAt = async (
  folder: string,
): Promise<
  | { readonly ok: true; readonly repository: Repository }
  | { readonly ok: false; readonly reason: string }
> => {
  const top = line(await git(folder, ["rev-parse", "--show-toplevel"], small))
  const common = await commonDir(folder)
  if (top === undefined || common === undefined)
    return { ok: false, reason: `${folder} isn't in a git repository.` }
  const home = homeOf(common)
  return {
    ok: true,
    repository: {
      top: await realpath(top).catch(() => top),
      commonDir: common,
      home,
      name: basename(home).replace(/\.git$/, "") || "repo",
    },
  }
}

/** Whether git accepts the name for a branch, and the name it means. */
export const validBranch = async (folder: string, name: string): Promise<boolean> => {
  if (name.startsWith("-") || name.includes("\n")) return false
  return line(await git(folder, ["check-ref-format", "--branch", name], small)) === name
}

/** The commit a branch points at, or undefined without one. */
export const branchTip = async (folder: string, branch: string): Promise<string | undefined> =>
  line(await git(folder, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], small))

/** The commit a revision names, or undefined. */
export const commitAt = async (folder: string, revision: string): Promise<string | undefined> =>
  line(await git(folder, ["rev-parse", "--verify", "-q", `${revision}^{commit}`], small))

export type Entry = {
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /** Whether git (or the person) locked it: it is never adopted or removed. */
  readonly locked: boolean
}

/** The repository's worktrees as git lists them, the main checkout first. */
export const entriesOf = async (folder: string): Promise<readonly Entry[] | undefined> => {
  const run = await git(folder, ["worktree", "list", "--porcelain"], listing)
  if (!run.ok) return undefined
  return run.out
    .split(/\n\n+/)
    .map((block) => block.split("\n"))
    .flatMap((lines) => {
      const path = lines.find((each) => each.startsWith("worktree "))?.slice(9)
      const head = lines.find((each) => each.startsWith("HEAD "))?.slice(5) ?? ""
      const branch = lines.find((each) => each.startsWith("branch "))?.slice(7)
      const locked = lines.some((each) => each === "locked" || each.startsWith("locked "))
      return path === undefined
        ? []
        : [{ path, head, locked, branch: branch?.replace(/^refs\/heads\//, "") ?? null }]
    })
}

/** Makes the worktree; the git run, whose failure says why not. */
export const addWorktree = (
  home: string,
  path: string,
  branch: string,
  start: { readonly create: true; readonly from: string } | { readonly create: false },
  platform: NodeJS.Platform = process.platform,
): Promise<Run> =>
  git(
    home,
    [
      ...(platform === "win32" ? ["-c", "core.longpaths=true"] : []),
      "worktree",
      "add",
      ...(start.create ? ["-b", branch, "--", path, start.from] : ["--", path, branch]),
    ],
    { ...small, ms: addMs },
  )

/** What a worktree holds that the main branch doesn't. */
export type Standing = {
  /** The main branch it is measured against; undefined where the repository has none. */
  readonly main: Main | undefined
  /**
   * Whether git could say what the worktree holds. Where it couldn't (a timeout, output too
   * long, any error), nothing else here is known, and a worktree is never removed on it.
   */
  readonly readable: boolean
  /** Why it couldn't, where it couldn't. */
  readonly why: string
  /** How many paths are changed or untracked (an untracked folder counts once). */
  readonly dirty: number
  /** Commits on HEAD that the main branch doesn't have; null where that can't be told. */
  readonly ahead: number | null
  /** Whether HEAD is an ancestor of the main branch: it holds nothing beyond its history. */
  readonly inMain: boolean
}

/** A big repository's status may take a while to read. */
export const statusMs = 120_000

/** What a worktree holds, read now. */
export const standingOf = async (path: string): Promise<Standing> => {
  const status = await git(path, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"], {
    cap: 16 * 1024 * 1024,
    ms: statusMs,
  })
  const main = await mainBranch(path)
  if (!status.ok)
    return {
      main,
      readable: false,
      why: status.kind === "big" ? "its status is too long to read" : said(status),
      dirty: 0,
      ahead: null,
      inMain: false,
    }
  const dirty = status.out.split("\0").filter((each) => each !== "").length
  if (!main) return { main, readable: true, why: "", dirty, ahead: null, inMain: false }
  const count = line(await git(path, ["rev-list", "--count", `${main.commit}..HEAD`], small))
  const ahead = count === undefined ? null : Number(count)
  return { main, readable: true, why: "", dirty, ahead, inMain: ahead === 0 }
}

/** Whether the worktree has submodules checked out, whose commits a removal would lose. */
export const hasSubmodules = async (path: string): Promise<boolean | undefined> => {
  const run = await git(path, ["submodule", "status"], listing)
  if (!run.ok) return undefined
  return run.out.split("\n").some((each) => each !== "" && !each.startsWith("-"))
}

/** Whether every commit of `ref` is in the main branch's history. */
export const heldByMain = async (folder: string, ref: string, main: Main): Promise<boolean> =>
  line(await git(folder, ["rev-list", "--count", `${main.commit}..${ref}`], small)) === "0"

/** The commit a worktree adopted from elsewhere started from: where it left the main branch. */
export const startOf = async (path: string): Promise<string> => {
  const main = await mainBranch(path)
  const head = (await commitAt(path, "HEAD")) ?? ""
  const base = main ? await mergeBase(path, "HEAD", main.commit) : undefined
  return base ?? head
}

// A commit made for kept work is Novadeck's own.
const author = {
  GIT_AUTHOR_NAME: "Novadeck",
  GIT_AUTHOR_EMAIL: "novadeck@localhost",
  GIT_COMMITTER_NAME: "Novadeck",
  GIT_COMMITTER_EMAIL: "novadeck@localhost",
}

/** A branch name as one ref component: slashes can't clash with a branch of the same stem. */
const flat = (name: string): string => name.replaceAll("/", "-")

/**
 * Names `commit` at a ref of its own, `refs/novadeck/kept/<branch, flat>-<what>-<short sha>`,
 * which no other branch's can clash with; its name, or undefined where it couldn't be made.
 */
export const keepCommit = async (
  folder: string,
  branch: string,
  what: string,
  commit: string,
): Promise<string | undefined> => {
  const ref = `refs/novadeck/kept/${flat(branch)}-${what}-${commit.slice(0, 8)}`
  const set = await git(folder, ["update-ref", ref, commit], small)
  return set.ok ? ref : undefined
}

/**
 * Keeps a worktree's uncommitted and untracked files (those no ignore rule hides) as a
 * commit on top of its HEAD, at a ref of `keepCommit`'s kind, made with a private index so
 * the worktree's own is never touched. Its name, or undefined where it couldn't be made.
 */
export const keepWork = async (path: string, branch: string): Promise<string | undefined> => {
  const folder = await mkdtemp(join(tmpdir(), "novadeck-kept-"))
  try {
    const env = { GIT_INDEX_FILE: join(folder, "index") }
    const steps = [
      ["read-tree", "HEAD"],
      ["add", "-A", "--", "."],
    ]
    for (const args of steps) {
      // eslint-disable-next-line no-await-in-loop -- Each step reads what the one before made.
      const run = await git(path, args, { ...listing, env, ms: statusMs })
      if (!run.ok) return undefined
    }
    const tree = line(await git(path, ["write-tree"], { ...small, env }))
    if (!tree) return undefined
    const commit = line(
      await git(
        path,
        [
          "-c",
          "commit.gpgsign=false",
          "commit-tree",
          tree,
          "-p",
          "HEAD",
          "-m",
          `Novadeck: work left uncommitted on ${branch}`,
        ],
        { ...small, env: { ...env, ...author } },
      ),
    )
    return commit ? await keepCommit(path, branch, "work", commit) : undefined
  } finally {
    await rm(folder, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * Keeps HEAD when only it reaches some commits: a detached HEAD, or a rebase stopped midway,
 * leaves commits that neither the branch nor the main branch holds. Its ref, undefined when
 * the branch or the main branch holds all of HEAD, and null where git couldn't tell.
 */
export const keepStrayHead = async (
  path: string,
  branch: string,
  main: Main | undefined,
): Promise<string | undefined | null> => {
  const head = await commitAt(path, "HEAD")
  if (head === undefined) return null
  const tip = await branchTip(path, branch)
  const held = async (ref: string | undefined): Promise<boolean | null> => {
    if (ref === undefined) return false
    const run = await git(path, ["merge-base", "--is-ancestor", head, ref], small)
    if (run.ok) return true
    return run.kind === "exit" && run.status === 1 ? false : null
  }
  const inBranch = await held(tip)
  const inMain = await held(main?.commit)
  if (inBranch === null || inMain === null) return null
  if (inBranch || inMain) return undefined
  return (await keepCommit(path, branch, "head", head)) ?? null
}

/** Removes the worktree's folder and git's record of it. */
export const removeFolder = (home: string, path: string): Promise<Run> =>
  git(home, ["worktree", "remove", "--force", "--", path], { ...small, ms: addMs })

/**
 * Forgets one worktree whose folder is gone, by deleting its own entry in the repository's
 * `worktrees` folder, and nothing else: `git worktree prune` would also forget the person's
 * own worktrees whose folders are away for now (an unmounted drive). A locked one stays.
 */
export const forgetEntry = async (commonDirectory: string, path: string): Promise<void> => {
  const parent = join(commonDirectory, "worktrees")
  const names = await readdir(parent).catch((): string[] => [])
  for (const name of names) {
    const entry = join(parent, name)
    // eslint-disable-next-line no-await-in-loop -- A few entries, read one at a time.
    const gitdir = await readFile(join(entry, "gitdir"), "utf8").catch(() => undefined)
    if (gitdir === undefined) continue
    const where = gitdir.trim().replace(/[\\/]\.git$/, "")
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (where === path && !(await stat(join(entry, "locked")).catch(() => undefined)))
      // eslint-disable-next-line no-await-in-loop -- As above.
      await rm(entry, { recursive: true, force: true })
  }
}

/** Deletes a branch whose commits the main branch holds; false where it wasn't deleted. */
export const deleteBranch = async (home: string, branch: string): Promise<boolean> =>
  (await git(home, ["branch", "-D", "--", branch], small)).ok
