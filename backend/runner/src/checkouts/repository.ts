import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
} from "node:fs/promises"
import { dirname, join, resolve } from "node:path"

import { workLimits } from "@novadeck/protocol"

import { git, timing, type Run } from "./git.js"

// Git, asked about a checkout: its main branch, a snapshot of its working tree, merges in
// memory. Every run is `git`: no shell, literal pathspecs, capped output, a timeout, and the
// person's own index never touched.

/** Untracked files: the largest one added to a snapshot. */
export const maxUntrackedBytes = 1024 * 1024

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
    return { name: cutName(ref.replace(/^refs\/(?:remotes|heads)\//, "")), commit, tree }
  }
  return undefined
}

/** The checkout's branch, or null when HEAD is detached. */
export const branchOf = async (root: string): Promise<string | null> => {
  const name = line(await git(root, ["symbolic-ref", "-q", "--short", "HEAD"], small))
  return name === undefined ? null : cutName(name)
}

/** A branch name cut to what the protocol carries. */
const cutName = (name: string): string => name.slice(0, workLimits.branch)

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

// Snapshot runs never run a clean filter of git-lfs, which would copy every file into .git/lfs.
const noLfs = [
  "-c",
  "filter.lfs.clean=",
  "-c",
  "filter.lfs.process=",
  "-c",
  "filter.lfs.required=false",
]

/**
 * Whether the repository keeps its index in parts (a split index), which a copy of the index
 * file alone would not carry.
 */
const splitIndex = async (root: string, person: string): Promise<boolean> => {
  const config = line(await git(root, ["config", "--type=bool", "core.splitIndex"], small))
  if (config === "true") return true
  const names = await readdir(dirname(person)).catch(() => [] as string[])
  return names.some((name) => name.startsWith("sharedindex."))
}

/**
 * Starts the private index from a copy of the person's own index (so git finds the stat data
 * of the files it has hashed and doesn't read them again), or from HEAD where there is no
 * index, it can't be copied or it is split. The person's index is only read.
 */
const startIndex = async (
  root: string,
  index: string,
  head: string,
  env: NodeJS.ProcessEnv,
): Promise<boolean> => {
  await rm(index, { force: true })
  await rm(`${index}.lock`, { force: true })
  const path = line(await git(root, ["rev-parse", "--git-path", "index"], small))
  if (path) {
    const person = resolve(root, path)
    const copied = !(await splitIndex(root, person)) && (await copyIndex(person, index))
    if (copied) return true
    await rm(index, { force: true })
  }
  return (await git(root, ["read-tree", head], { ...small, env, ms: timing.gitMs * 6 })).ok
}

/**
 * Copies the person's index to the private one, with the original's times. Git trusts an
 * entry's stat data only when the file was older than the index itself, and re-reads the rest
 * ("racily clean" entries); a copy dated now would trust a file rewritten, at the same size,
 * in the moment the person's index was written. The copy is dated a second earlier still, so
 * a rounded time only ever makes git re-read more.
 */
const copyIndex = async (person: string, index: string): Promise<boolean> => {
  try {
    const { atime, mtime } = await stat(person)
    await copyFile(person, index)
    await utimes(index, atime, new Date(mtime.getTime() - 1_000))
    return true
  } catch {
    return false
  }
}

/** The untracked files of the checkout (.gitignore respected) to add, and whether any was left out. */
const untrackedFiles = async (
  root: string,
  env: NodeJS.ProcessEnv,
  held: Held,
): Promise<
  { readonly paths: string[]; readonly secret: string[]; readonly skipped: boolean } | undefined
> => {
  // Where status shows no untracked files, a snapshot takes none.
  const shown = line(await git(root, ["config", "--get", "status.showUntrackedFiles"], small))
  if (shown !== undefined && /^(no|false|off|0)$/i.test(shown))
    return { paths: [], secret: [], skipped: false }
  const run = await git(root, ["ls-files", "-o", "--exclude-standard", "-z"], {
    ...listing,
    env,
  })
  if (!run.ok) return undefined
  const listed = run.out.split("\0").filter((name) => name !== "")
  // A file that may hold secrets is never read or hashed, so not into any object store: it is
  // only named.
  const secret = listed.filter((name) => held(join(root, name)))
  const names = listed.filter((name) => !held(join(root, name)))
  const sizes = await Promise.all(
    names.map((name) =>
      lstat(join(root, name)).then(
        (stats) => stats.size,
        // Gone since it was listed, or unreadable: not added.
        () => Infinity,
      ),
    ),
  )
  const paths = names.filter((_, at) => sizes[at]! <= maxUntrackedBytes)
  return { paths, secret, skipped: paths.length < names.length }
}

/** Whether a file (by its full path) may hold secrets: see the companions' `secrets`. */
export type Held = (path: string) => boolean

/** The checkout's working tree as a tree; `skipped` where untracked files over the size limit were left out. */
export type Taken = {
  readonly tree: string
  /** The commit it is on; empty before the repository's first commit. */
  readonly head: string
  readonly skipped: boolean
  /** Untracked files that may hold secrets: left out of the tree, named only. */
  readonly secret: readonly string[]
  /** Where its objects are, for the runs that read them again (set with a private object folder). */
  readonly env: NodeJS.ProcessEnv | undefined
}

/**
 * The environment that writes objects to a folder of our own, with the repository's own as
 * an alternate to read from: what a snapshot makes (blobs of every file it hashes, trees,
 * commits) never lands in the person's object store.
 */
export const privateObjects = async (
  root: string,
  folder: string,
): Promise<NodeJS.ProcessEnv | undefined> => {
  const path = line(await git(root, ["rev-parse", "--git-path", "objects"], small))
  if (!path) return undefined
  await mkdir(folder, { recursive: true })
  return {
    GIT_OBJECT_DIRECTORY: folder,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedEntry(resolve(root, path)),
  }
}

/**
 * A folder as one entry of the alternates list, which is split at the path separator (`:`, or
 * `;` on Windows): git reads an entry that starts with a quote as C-quoted, so a folder with
 * the separator in its name stays one.
 */
const quotedEntry = (folder: string): string =>
  `"${folder.replace(/[\\"]/g, "\\$&").replace(/\n/g, "\\n")}"`

/**
 * Takes the checkout's working tree (what `git add -A` would stage, .gitignore respected) as
 * a tree, without touching the person's index. Each time a private index file, `index`, is
 * made afresh from a copy of the person's own (so nothing of an earlier pass lingers and git
 * hashes only the tracked files whose stat data changed), the tracked changes are staged and
 * the untracked files too, but those over 1 MiB, which are left out (`skipped`). A file git
 * can't read is left out too. Undefined where it can't be taken (no commit yet, git slow).
 */
export const snapshotTree = async (
  root: string,
  index: string,
  objects: string | undefined,
  /** Which untracked files may hold secrets: those are named, never read. */
  held: Held,
): Promise<Taken | undefined> => {
  const found = line(await git(root, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], small))
  // Before the first commit there is no work to measure against main, which only layers read.
  const head = found ?? ""
  const own = objects === undefined ? undefined : await privateObjects(root, objects)
  // Reading every file of a big repository once takes longer than a look at its state.
  const slow = { ...small, env: { ...own, GIT_INDEX_FILE: index }, ms: timing.gitMs * 6 }
  if (found) {
    if (!(await startIndex(root, index, found, slow.env))) return undefined
  } else {
    await rm(index, { force: true })
    await rm(`${index}.lock`, { force: true })
    if (!(await git(root, ["read-tree", "--empty"], slow)).ok) return undefined
  }
  // A file that can't be read fails the run but not the files before it (`--ignore-errors`).
  const tracked = await git(root, [...noLfs, "add", "-u", "--ignore-errors"], slow)
  if (!tracked.ok && tracked.kind !== "exit") return undefined
  const untracked = await untrackedFiles(root, slow.env, held)
  if (!untracked) return undefined
  if (untracked.paths.length > 0) {
    const added = await git(
      root,
      [...noLfs, "add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"],
      { ...slow, input: untracked.paths.join("\0") + "\0" },
    )
    if (!added.ok && added.kind !== "exit") return undefined
  }
  const tree = line(await git(root, ["write-tree"], slow))
  return tree
    ? { tree, head, skipped: untracked.skipped, secret: untracked.secret, env: own }
    : undefined
}

/** Whether a tree object is in the repository: false only where git says it is not. */
export const treeGone = async (
  root: string,
  tree: string,
  env?: NodeJS.ProcessEnv,
): Promise<boolean> => {
  const run = await git(root, ["cat-file", "-e", `${tree}^{tree}`], {
    ...small,
    ...(env && { env }),
  })
  return !run.ok && run.kind === "exit" && run.status > 0
}

/**
 * Rebuilds a private object folder with only what the `trees` reach (the objects that are
 * in the folder, not the repository's own), as one pack in a fresh folder that then takes
 * the old one's place: what was made for snapshots read since is let go, and the trees stay
 * readable. False where it could not be done; the folder is then as it was. Nothing may be
 * reading the folder.
 */
export const repack = async (
  root: string,
  folder: string,
  trees: readonly string[],
): Promise<boolean> => {
  const own = await privateObjects(root, folder)
  if (!own) return false
  const fresh = `${folder}.new`
  const old = `${folder}.old`
  await rm(fresh, { recursive: true, force: true })
  await rm(old, { recursive: true, force: true })
  const big = { cap: 256 * 1024 * 1024, env: own, ms: timing.gitMs * 6 }
  const gone = await Promise.all(trees.map((tree) => treeGone(root, tree, own)))
  const here = trees.filter((_, at) => !gone[at])
  let keep = ""
  if (here.length > 0) {
    const reached = await git(root, ["rev-list", "--objects", ...here, "--"], big)
    // Only the folder's own: with no alternates, what git finds is what is in it.
    const present = await git(
      root,
      ["cat-file", "--batch-all-objects", "--batch-check=%(objectname)"],
      { ...big, env: { GIT_OBJECT_DIRECTORY: folder, GIT_ALTERNATE_OBJECT_DIRECTORIES: "" } },
    )
    if (!reached.ok || !present.ok) return false
    const have = new Set(present.out.split("\n").filter(Boolean))
    keep = reached.out
      .split("\n")
      .map((each) => each.split(" ")[0]!)
      .filter((id) => have.has(id))
      .join("\n")
  }
  try {
    await mkdir(join(fresh, "pack"), { recursive: true })
    if (keep !== "") {
      const packed = await git(root, ["pack-objects", "-q", join(fresh, "pack", "pack")], {
        ...big,
        input: `${keep}\n`,
      })
      if (!packed.ok) throw new Error("pack-objects failed")
    }
    await rename(folder, old)
    try {
      await rename(fresh, folder)
    } catch (error) {
      await rename(old, folder).catch(() => {})
      throw error
    }
    await rm(old, { recursive: true, force: true })
    return true
  } catch {
    await rm(fresh, { recursive: true, force: true }).catch(() => {})
    return false
  }
}

/** A commit holding `tree` on top of the `parents`, nobody's (see `author`). */
export const commitOf = async (
  root: string,
  tree: string,
  parents: readonly string[],
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  line(
    await git(
      root,
      [
        "-c",
        "commit.gpgsign=false",
        "commit-tree",
        tree,
        ...parents.flatMap((parent) => ["-p", parent]),
        "-m",
        "Novadeck snapshot",
      ],
      {
        ...small,
        env: { ...env, ...author },
      },
    ),
  )

/** A commit holding `tree` on top of `head`, to merge. */
export const snapshotCommit = (
  root: string,
  tree: string,
  head: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> => commitOf(root, tree, [head], env)

/**
 * What `git merge-tree --write-tree --name-only --no-messages -z` printed: the tree of the
 * merge, then the names of the files that conflict, each ended by a NUL.
 */
export const parseMerge = (
  out: string,
): { readonly tree: string; readonly conflicts: string[] } => {
  const [tree = "", ...names] = out.split("\0")
  return { tree, conflicts: names.filter((name) => name !== "") }
}

/** What merging two commits does. */
export type Merge =
  | { readonly state: "clean"; readonly tree: string }
  | { readonly state: "conflict"; readonly files: readonly string[] }
  // This git can't merge without a checkout (before 2.38), or it failed: nothing is known.
  | { readonly state: "unknown" }

/** Merges `theirs` into `ours` in memory (`merge-tree`): clean, or the files that conflict. */
export const mergeTrees = async (
  root: string,
  ours: string,
  theirs: string,
  env?: NodeJS.ProcessEnv,
): Promise<Merge> => {
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
    env ? { ...listing, env } : listing,
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
export const mergeBase = async (
  root: string,
  a: string,
  b: string,
  env?: NodeJS.ProcessEnv,
): Promise<string | undefined> =>
  line(await git(root, ["merge-base", a, b], env ? { ...small, env } : small))
