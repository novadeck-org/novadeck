import { realpath } from "node:fs/promises"
import { resolve } from "node:path"

import { git, timing, type Run } from "../companions/changes.js"
import { parseMerge, parseNumstat, type Lines } from "./lines.js"

// Git, asked about a checkout for Works. Every run is the companions' `git`: no shell, literal
// pathspecs, capped output, a timeout, and the person's own index never touched.

const small = { cap: 64 * 1024 }
const listing = { cap: 8 * 1024 * 1024 }

/** What a name that git prints is, without its line end. */
const line = (run: Run): string | undefined => (run.ok ? run.out.trim() || undefined : undefined)

/** The main branch a work is measured against: as named, its commit and its tree. */
export type Main = { readonly name: string; readonly commit: string; readonly tree: string }

/**
 * The repository's main branch: where `refs/remotes/origin/HEAD` points if it is set, else
 * the local `main`, else `master`; undefined when there is none.
 */
export const mainBranch = async (root: string): Promise<Main | undefined> => {
  const remote = line(await git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], small))
  const candidates = [
    ...(remote?.startsWith("refs/remotes/") ? [remote] : []),
    "refs/heads/main",
    "refs/heads/master",
  ]
  for (const ref of candidates) {
    // eslint-disable-next-line no-await-in-loop -- The first that exists is the one.
    const commit = line(await git(root, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], small))
    if (!commit) continue
    // eslint-disable-next-line no-await-in-loop -- Only the one found is asked for its tree.
    const tree = line(await git(root, ["rev-parse", "--verify", "-q", `${commit}^{tree}`], small))
    if (!tree) continue
    return { name: ref.replace(/^refs\/(?:remotes|heads)\//, ""), commit, tree }
  }
  return undefined
}

/** The checkout's branch, or null when HEAD is detached. */
export const branchOf = async (root: string): Promise<string | null> =>
  line(await git(root, ["symbolic-ref", "-q", "--short", "HEAD"], small)) ?? null

/**
 * The repository's common git folder, as one spelling for all its worktrees; undefined if
 * git can't tell. Works of one repository can conflict with each other.
 */
export const commonDir = async (root: string): Promise<string | undefined> => {
  const dir = line(await git(root, ["rev-parse", "--git-common-dir"], small))
  if (!dir) return undefined
  const full = resolve(root, dir)
  return realpath(full).catch(() => full)
}

/** The checkout's working tree as it is now: a tree, and a commit on HEAD holding it. */
export type Snapshot = { readonly tree: string; readonly commit: string; readonly head: string }

// A commit made for a merge is nobody's: a fixed name and time, so the same tree on the same
// HEAD is always the same commit.
const author = {
  GIT_AUTHOR_NAME: "Novadeck",
  GIT_AUTHOR_EMAIL: "novadeck@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Novadeck",
  GIT_COMMITTER_EMAIL: "novadeck@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
}

/**
 * Takes the checkout's working tree (what `git add -A` would stage, untracked files too,
 * .gitignore respected) as a tree, without touching the person's index: the files are added
 * to a private index file, `index`, which stays between snapshots so git only reads what
 * changed. A fresh one starts from HEAD. Undefined where it can't be taken (no commit yet,
 * a file unreadable, git slow); the private index is then dropped to start afresh.
 */
export const snapshotTree = async (
  root: string,
  index: string,
  fresh: boolean,
): Promise<{ readonly tree: string; readonly head: string } | undefined> => {
  const head = line(await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], small))
  if (!head) return undefined
  // Reading every file of a big repository once takes longer than a look at its state.
  const slow = { ...small, env: { GIT_INDEX_FILE: index }, ms: timing.gitMs * 6 }
  if (fresh && !(await git(root, ["read-tree", head], slow)).ok) return undefined
  if (!(await git(root, ["add", "-A"], slow)).ok) return undefined
  const tree = line(await git(root, ["write-tree"], slow))
  return tree ? { tree, head } : undefined
}

/** A commit holding `tree` on top of `head`, to merge. */
export const snapshotCommit = async (
  root: string,
  tree: string,
  head: string,
): Promise<string | undefined> =>
  line(
    await git(
      root,
      ["-c", "commit.gpgsign=false", "commit-tree", tree, "-p", head, "-m", "Novadeck snapshot"],
      {
        ...small,
        env: author,
      },
    ),
  )

/** What merging two commits does. */
export type Merge =
  | { readonly state: "clean"; readonly tree: string }
  | { readonly state: "conflict"; readonly files: readonly string[] }
  // This git can't merge without a checkout (before 2.38), or it failed: nothing is known.
  | { readonly state: "unknown" }

/** Merges `theirs` into `ours` in memory (`merge-tree`): clean, or the files that conflict. */
export const mergeTrees = async (root: string, ours: string, theirs: string): Promise<Merge> => {
  const run = await git(
    root,
    [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "--allow-unrelated-histories",
      "-z",
      ours,
      theirs,
    ],
    listing,
  )
  if (run.ok) return { state: "clean", tree: parseMerge(run.out).tree }
  // Exit 1 is a conflict only with the merged tree printed first, as an error exits 1 too.
  if (run.kind === "exit" && run.status === 1) {
    const { tree, conflicts } = parseMerge(run.out ?? "")
    if (/^[0-9a-f]{40,64}$/.test(tree)) return { state: "conflict", files: conflicts }
  }
  return { state: "unknown" }
}

/** The best common ancestor of two commits; undefined if they have none. */
export const mergeBase = async (root: string, a: string, b: string): Promise<string | undefined> =>
  line(await git(root, ["merge-base", a, b], small))

/**
 * The lines each file differs by from `from` to `to` (commits or trees), renames shown as
 * a removal and an addition; undefined where git can't tell (an object gone, too long a list).
 */
export const numstat = async (
  root: string,
  from: string,
  to: string,
): Promise<Map<string, Lines> | undefined> => {
  const run = await git(
    root,
    ["diff", "--numstat", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", from, to],
    listing,
  )
  return run.ok ? parseNumstat(run.out) : undefined
}
