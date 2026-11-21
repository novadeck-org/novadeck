import { existsSync } from "node:fs"
import { mkdtemp, readdir, readFile, realpath, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, dirname, join, resolve } from "node:path"

import { git, type Run } from "../checkouts/git.js"
import { currentBranch, targetOf } from "../checkouts/home.js"
import {
  commonDir,
  landedIn,
  mainBranch,
  mergeBase,
  mergeTrees,
  type Main,
} from "../checkouts/repository.js"

// Git, run for the worktrees agents open, take and close.

const small = { cap: 64 * 1024 }
const listing = { cap: 4 * 1024 * 1024 }

/** `git worktree add` may check out a big repository: past the helper's usual 5 seconds. */
export const addMs = 60_000
/**
 * What a git run a close or an open can't do without may take: a loaded Windows machine takes
 * past the helper's usual 5 seconds for a `rev-parse`, and a close refused for it stays refused.
 */
const patient = { ...small, ms: addMs }

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
  line(await git(folder, ["rev-parse", "--verify", "-q", `refs/heads/${branch}^{commit}`], patient))

/** The commit a revision names, or undefined. */
export const commitAt = async (folder: string, revision: string): Promise<string | undefined> =>
  line(await git(folder, ["rev-parse", "--verify", "-q", `${revision}^{commit}`], patient))

export type Entry = {
  readonly path: string
  readonly branch: string | null
  readonly head: string
  /** Whether git (or the person) locked it: it is never adopted or removed. */
  readonly locked: boolean
}

/** The repository's worktrees as git lists them, the main checkout first. */
export const entriesOf = async (folder: string): Promise<readonly Entry[] | undefined> => {
  const run = await git(folder, ["worktree", "list", "--porcelain"], { ...listing, ms: addMs })
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

/** What a worktree holds that its home doesn't. */
export type Standing = {
  /**
   * What it is measured against: home (see `targetOf`), else the repository's main; undefined
   * where there is neither.
   */
  readonly main: Main | undefined
  /** Every branch whose holding its work makes the work home: home, home's remote one, main. */
  readonly holders: readonly Main[]
  /** Home's name, where it isn't the repository's main (see `targetOf`). */
  readonly home?: string
  /**
   * Whether git could say what the worktree holds. Where it couldn't (a timeout, output too
   * long, any error), nothing else here is known, and a worktree is never removed on it.
   */
  readonly readable: boolean
  /** Why it couldn't, where it couldn't. */
  readonly why: string
  /** How many paths are changed or untracked (an untracked folder counts once). */
  readonly dirty: number
  /** Commits on HEAD that home doesn't have; null where that can't be told. */
  readonly ahead: number | null
  /**
   * Whether a holder (home, home's remote one or the repository's main) holds all of HEAD: HEAD
   * is its ancestor, or merging HEAD into it changes nothing (a squash or rebase merge). Then
   * there is nothing beyond it to lose.
   */
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
  const target = await targetOf(path, (await currentBranch(path)) ?? null)
  const main = target?.main
  const holders = target?.holders ?? []
  const home = target?.home === undefined ? {} : { home: target.home }
  if (!status.ok)
    return {
      main,
      holders,
      ...home,
      readable: false,
      why: status.kind === "big" ? "its status is too long to read" : said(status),
      dirty: 0,
      ahead: null,
      inMain: false,
    }
  const dirty = status.out.split("\0").filter((each) => each !== "").length
  if (!main)
    return { main, holders, ...home, readable: true, why: "", dirty, ahead: null, inMain: false }
  const count = line(await git(path, ["rev-list", "--count", `${main.commit}..HEAD`], small))
  const ahead = count === undefined ? null : Number(count)
  // Commits home lacks by hash may still be in it by content (squash- and rebase-merged), or in
  // another holder.
  const inMain = ahead === 0 || (ahead !== null && (await heldByAny(path, "HEAD", holders)))
  return { main, holders, ...home, readable: true, why: "", dirty, ahead, inMain }
}

/**
 * Whether merging `ref` into the main branch would change nothing, or, where it conflicts, would
 * have at the commit its work landed in: the same test the Worktrees panel's Works uses
 * (`merge-tree` is clean and gives main's own tree, else a conflict and `landedIn`). That is so
 * for a branch merged by any means, squash and rebase merges included, also once main has
 * changed the same lines again; not for work main reverted, which merges cleanly.
 */
const mergedInto = async (folder: string, ref: string, main: Main): Promise<boolean> => {
  const merge = await mergeTrees(folder, main.commit, ref)
  if (merge.state === "clean") return merge.tree === main.tree
  return merge.state === "conflict" && (await landedIn(folder, main, ref)) !== undefined
}

/** Whether the worktree has submodules checked out, whose commits a removal would lose. */
export const hasSubmodules = async (path: string): Promise<boolean | undefined> => {
  const run = await git(path, ["submodule", "status"], { ...listing, ms: addMs })
  if (!run.ok) return undefined
  return run.out.split("\n").some((each) => each !== "" && !each.startsWith("-"))
}

/**
 * The untracked folders of the worktree that are git repositories of their own, at any depth (an
 * agent's clone of a library, say), which git lists as folders and never looks into: a commit
 * keeps one only as a gitlink, a hash with none of its files or commits. Ignored ones are not
 * looked for, as ignored files are never kept. Only those folders are kept as git lists every
 * untracked file, so `cap` bounds them alone, however many files there are. Undefined where git
 * couldn't list them.
 */
export const nestedRepositories = async (
  path: string,
  cap = listing.cap,
): Promise<readonly string[] | undefined> => {
  const run = await git(path, ["ls-files", "--others", "--exclude-standard", "-z"], {
    cap,
    ms: statusMs,
    entries: (name) => name.endsWith("/"),
  })
  if (!run.ok) return undefined
  return run.out
    .split("\0")
    .filter((name) => name.endsWith("/"))
    .map((name) => name.slice(0, -1))
}

/**
 * What a repository nested in a worktree holds that a removal would lose, in a few words, or
 * undefined where it holds nothing of its own: no uncommitted or untracked file (ignored ones go,
 * as everywhere), no stash, no submodule checked out, and every commit of its HEAD and its local
 * branches on one of its remote-tracking branches, as last fetched. Where git can't tell, it is
 * "what Novadeck couldn't read", and the repository counts as holding work.
 */
export const nestedWork = async (path: string): Promise<string | undefined> => {
  const status = await git(path, ["status", "--porcelain=v1", "--untracked-files=normal", "-z"], {
    ...small,
    ms: statusMs,
  })
  if (!status.ok) return "what Novadeck couldn't read"
  if (status.out !== "") return "uncommitted or untracked files"
  const stash = await git(path, ["rev-parse", "--verify", "-q", "refs/stash"], patient)
  if (stash.ok) return "a stash"
  if (!(stash.kind === "exit" && stash.status === 1)) return "what Novadeck couldn't read"
  const submodules = await hasSubmodules(path)
  if (submodules !== false)
    return submodules ? "submodules checked out" : "what Novadeck couldn't read"
  const head = await git(path, ["rev-parse", "--verify", "-q", "HEAD"], patient)
  if (!head.ok && !(head.kind === "exit" && head.status === 1)) return "what Novadeck couldn't read"
  // A repository with no commit yet, and nothing in it, holds nothing.
  const from = head.ok ? ["HEAD", "--branches"] : ["--branches"]
  const unpushed = line(
    await git(path, ["rev-list", "--count", ...from, "--not", "--remotes"], patient),
  )
  if (unpushed === undefined) return "what Novadeck couldn't read"
  return unpushed === "0" ? undefined : "commits no remote has"
}

/**
 * Whether the main branch holds all of `ref`: every commit is in its history, or merging it
 * changes nothing (squash- and rebase-merged work, which git's own check calls unmerged).
 */
export const heldByMain = async (folder: string, ref: string, main: Main): Promise<boolean> =>
  line(await git(folder, ["rev-list", "--count", `${main.commit}..${ref}`], small)) === "0" ||
  (await mergedInto(folder, ref, main))

/** Whether one of `holders` holds all of `ref`, as `heldByMain` tells it. */
export const heldByAny = async (
  folder: string,
  ref: string,
  holders: readonly Main[],
): Promise<boolean> => {
  for (const holder of holders)
    // eslint-disable-next-line no-await-in-loop -- Few holders, the first that holds it.
    if (await heldByMain(folder, ref, holder)) return true
  return false
}

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
 * leaves commits that neither the branch nor a holder (home, home's remote one, the main branch)
 * holds. Its ref, undefined when the branch or a holder holds all of HEAD, and null where git
 * couldn't tell.
 */
export const keepStrayHead = async (
  path: string,
  branch: string,
  holders: readonly Main[],
): Promise<string | undefined | null> => {
  const head = await commitAt(path, "HEAD")
  if (head === undefined) return null
  const tip = await branchTip(path, branch)
  const held = async (ref: string | undefined): Promise<boolean | null> => {
    if (ref === undefined) return false
    const run = await git(path, ["merge-base", "--is-ancestor", head, ref], patient)
    if (run.ok) return true
    return run.kind === "exit" && run.status === 1 ? false : null
  }
  const inBranch = await held(tip)
  if (inBranch === null) return null
  if (inBranch) return undefined
  for (const holder of holders) {
    // eslint-disable-next-line no-await-in-loop -- Few holders, the first that holds it.
    const inHolder = await held(holder.commit)
    if (inHolder === null) return null
    if (inHolder) return undefined
  }
  return (await keepCommit(path, branch, "head", head)) ?? null
}

/**
 * Removes the worktree's folder and git's record of it. Without `force` git itself refuses
 * a worktree with modified or untracked files, so a file written after Novadeck's own check is
 * never deleted; with it (after what it holds was kept on refs) git removes it whatever it holds.
 */
export const removeFolder = (home: string, path: string, force: boolean): Promise<Run> =>
  git(home, ["worktree", "remove", ...(force ? ["--force"] : []), "--", path], {
    ...small,
    ms: addMs,
  })

/**
 * Forgets one worktree whose folder is gone, by deleting its own entry in the repository's
 * `worktrees` folder, and nothing else: `git worktree prune` would also forget the person's
 * own worktrees whose folders are away for now (an unmounted drive). A locked one stays.
 */
/**
 * Whether two paths name the same folder as git writes them: git keeps a worktree's path with
 * `/` on Windows too, and Windows doesn't tell case apart.
 */
const samePath = (a: string, b: string): boolean => {
  const [left, right] = [resolve(a), resolve(b)]
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right
}

export const forgetEntry = async (commonDirectory: string, path: string): Promise<void> => {
  const parent = join(commonDirectory, "worktrees")
  const names = await readdir(parent).catch((): string[] => [])
  for (const name of names) {
    const entry = join(parent, name)
    // eslint-disable-next-line no-await-in-loop -- A few entries, read one at a time.
    const gitdir = await readFile(join(entry, "gitdir"), "utf8").catch(() => undefined)
    if (gitdir === undefined) continue
    // A relative path (git's worktree.useRelativePaths) is from the entry's own folder.
    const where = resolve(entry, gitdir.trim().replace(/[\\/]\.git$/, ""))
    // eslint-disable-next-line no-await-in-loop -- As above.
    if (samePath(where, path) && !(await stat(join(entry, "locked")).catch(() => undefined)))
      // eslint-disable-next-line no-await-in-loop -- As above.
      await rm(entry, { recursive: true, force: true })
  }
}

/**
 * Finishes a `git worktree remove` that stopped partway, as one does on Windows when a file in
 * the folder is still held for a moment (a virus scan, a process just ended): git deletes the
 * folder, then its own record of the worktree even where the folder wouldn't go, so what is
 * left of a folder git no longer lists was git's to delete, and goes now, retried while a file
 * is held. Git's own listing (`home` is the repository's main folder) says so, compared by real
 * path as `take` compares; where git can't list its worktrees, or still lists this one (it
 * refused before deleting anything), nothing is touched. True once the folder is gone.
 */
export const finishRemoval = async (home: string, path: string): Promise<boolean> => {
  const entries = await entriesOf(home)
  if (entries === undefined) return false
  const real = await realpath(path).catch(() => path)
  for (const entry of entries)
    // eslint-disable-next-line no-await-in-loop -- A few worktrees, one at a time.
    if (samePath(await realpath(entry.path).catch(() => entry.path), real)) return false
  // Its error is no news: whether the folder is gone is what counts.
  await rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(
    () => undefined,
  )
  return !existsSync(path)
}

/** Makes `branch` track `upstream` (a remote-tracking ref); false where git refused. */
export const setUpstream = async (
  home: string,
  branch: string,
  upstream: string,
): Promise<boolean> =>
  (await git(home, ["branch", `--set-upstream-to=${upstream}`, branch], patient)).ok

/** Deletes a branch whose commits the main branch holds; false where it wasn't deleted. */
export const deleteBranch = async (home: string, branch: string): Promise<boolean> =>
  (await git(home, ["branch", "-D", "--", branch], small)).ok
