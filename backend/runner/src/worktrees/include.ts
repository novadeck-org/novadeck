import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { git } from "../checkouts/git.js"

// The ignored files a new worktree gets from the checkout it is made from, as Conductor, Claude
// Code and the Codex app give theirs: the patterns of the repository's `.worktreeinclude` (in
// .gitignore's syntax), else `.env*`, pick among the files git ignores there. Tracked files are
// the worktree's own and untracked ones that aren't ignored stay where they are.

/** The file at a checkout's top whose patterns name what is copied. */
export const includeFile = ".worktreeinclude"

/** What is copied where the repository has no `.worktreeinclude`. */
export const defaultPatterns = [".env*"] as const

/** The most a worktree gets: past it, the rest is left and said to be. */
export const includeLimit: Limit = { files: 2_000, bytes: 512 * 1024 * 1024 }

/** How long one listing of the checkout may take. */
const listMs = 20_000
const listing = { cap: 4 * 1024 * 1024, truncate: true, ms: listMs }

/** How many files are copied at once. */
const together = 8

export type Included = {
  /** The checkout's top folder they were copied from. */
  readonly from: string
  /** Where the patterns came from: the repository's `.worktreeinclude`, else `.env*`. */
  readonly by: "file" | "default"
  /** The files copied, relative to the worktree's top with `/`, shallowest first. */
  readonly copied: readonly string[]
  /** How many matching files weren't copied: past the limit, or a copy that failed. */
  readonly left: number
  /** Git couldn't list the checkout's files, so nothing was copied. */
  readonly unread?: true
}

/**
 * The lines git reads as patterns, with Windows line ends dropped. Whether one has a `/` (or is a
 * negation, which may undo one that has) decides whether it reaches into an ignored folder.
 */
export const patternLines = (text: string): readonly string[] =>
  text.split(/\r?\n/).filter((line) => line.trim() !== "" && !line.startsWith("#"))

/**
 * The patterns that reach into a folder git ignores as a whole (node_modules, dist, .venv): those
 * that name a path, with a `/` in them, and the negations that may take some of it back. `.env*`
 * alone matches at any depth, so it would pick a package's own `.env` inside node_modules and
 * leave a node_modules that is no install.
 */
export const reaching = (lines: readonly string[]): readonly string[] =>
  lines.filter((line) => line.startsWith("!") || line.includes("/"))

/** The paths of a NUL-ended listing. */
const pathsOf = (out: string): readonly string[] => out.split("\0").filter((path) => path !== "")

/** The folders above a path, each with its trailing `/`: `a/b/c` has `a/` and `a/b/`. */
const foldersAbove = (path: string): readonly string[] => {
  const parts = path.split("/").slice(0, -1)
  return parts.map((_, at) => parts.slice(0, at + 1).join("/") + "/")
}

/** Shallowest first, then by path, so a top-level `.env` is never the one past the limit. */
const byDepth = (a: string, b: string): number =>
  a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0)

/**
 * The ignored files of `top` that `lines` pick, as `/` paths relative to it: undefined where git
 * couldn't list them.
 */
export const pickedFiles = async (
  top: string,
  lines: readonly string[],
): Promise<readonly string[] | undefined> => {
  if (lines.length === 0) return []
  const scratch = await mkdtemp(join(tmpdir(), "novadeck-include-"))
  try {
    const listed = async (patterns: readonly string[], name: string) => {
      const file = join(scratch, name)
      await writeFile(file, patterns.join("\n") + "\n")
      const run = await git(
        top,
        ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${file}`],
        listing,
      )
      return run.ok ? pathsOf(run.out).filter((path) => !path.endsWith("/")) : undefined
    }
    // What git ignores: files one by one, and folders ignored as a whole once, with their `/`.
    const ignored = await git(
      top,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      listing,
    )
    if (!ignored.ok) return undefined
    const entries = pathsOf(ignored.out)
    const files = new Set(entries.filter((path) => !path.endsWith("/")))
    const folders = new Set(entries.filter((path) => path.endsWith("/")))
    const folderOf = (path: string) => foldersAbove(path).find((folder) => folders.has(folder))
    const matched = await listed(lines, "all")
    if (matched === undefined) return undefined
    const loose = matched.filter((path) => files.has(path))
    const inside = matched.filter((path) => folderOf(path) !== undefined)
    const paths = reaching(lines)
    const named =
      inside.length === 0 || paths.every((line) => line.startsWith("!"))
        ? new Set<string>()
        : new Set(await listed(paths, "paths"))
    return [...loose, ...inside.filter((path) => named.has(path))].toSorted(byDepth)
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The patterns that pick what is copied from `top`, and where they came from. */
const patternsAt = async (
  top: string,
): Promise<{ readonly by: Included["by"]; readonly lines: readonly string[] }> => {
  const text = await readFile(join(top, includeFile), "utf8").catch(() => undefined)
  // An empty `.worktreeinclude` is one that copies nothing.
  return text === undefined
    ? { by: "default", lines: defaultPatterns }
    : { by: "file", lines: patternLines(text) }
}

/**
 * Copies one file as it is: a symlink as a symlink to the same target, a file as a copy-on-write
 * clone where the file system makes one (APFS, btrfs, XFS, ReFS) and a copy elsewhere. Never
 * over a file the worktree has. False where it wasn't copied.
 */
const copyOne = async (from: string, to: string): Promise<boolean> => {
  try {
    const info = await lstat(from)
    await mkdir(dirname(to), { recursive: true })
    if (info.isSymbolicLink()) {
      await symlink(await readlink(from), to)
      return true
    }
    if (!info.isFile()) return false
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    return true
  } catch {
    return false
  }
}

export type Limit = { readonly files: number; readonly bytes: number }

/** The files, in order, that fit the limit: its count, and their sizes summed. */
const withinLimit = async (
  top: string,
  paths: readonly string[],
  limit: Limit,
): Promise<readonly string[]> => {
  const fitting: string[] = []
  let bytes = 0
  for (const path of paths.slice(0, limit.files)) {
    // eslint-disable-next-line no-await-in-loop -- Each size decides whether the next one fits.
    const size = await lstat(join(top, path)).then(
      (info) => info.size,
      () => 0,
    )
    if (bytes + size > limit.bytes) break
    bytes += size
    fitting.push(path)
  }
  return fitting
}

/**
 * Gives a new worktree the ignored files of the checkout it was made from that the patterns pick.
 * It never fails the open: what it couldn't copy is counted in `left`.
 */
export const copyIncluded = async (
  top: string,
  worktree: string,
  limit: Limit = includeLimit,
): Promise<Included> => {
  const { by, lines } = await patternsAt(top)
  const picked = await pickedFiles(top, lines)
  if (picked === undefined) return { from: top, by, copied: [], left: 0, unread: true }
  const fitting = await withinLimit(top, picked, limit)
  const copied: string[] = []
  for (let at = 0; at < fitting.length; at += together) {
    const batch = fitting.slice(at, at + together)
    // eslint-disable-next-line no-await-in-loop -- A few at a time, so a big list doesn't open every file at once.
    const done = await Promise.all(
      batch.map((path) => copyOne(join(top, path), join(worktree, ...path.split("/")))),
    )
    copied.push(...batch.filter((_, index) => done[index]))
  }
  return {
    from: top,
    by,
    copied,
    left: picked.length - copied.length,
  }
}
