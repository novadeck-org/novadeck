import { constants } from "node:fs"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, isAbsolute, join, posix, resolve } from "node:path"

import { git } from "../checkouts/git.js"

// The ignored files a new worktree gets from the checkout it is made from, as Conductor, Claude
// Code and the Codex app give theirs: the patterns of the repository's `.worktreeinclude` (in
// .gitignore's syntax), else `.env*`, pick among the files git ignores there. Tracked files are
// the worktree's own and untracked ones that aren't ignored stay where they are.

/** The file at a checkout's top whose patterns name what is copied. */
export const includeFile = ".worktreeinclude"

/** What is copied where the repository has no `.worktreeinclude`. */
export const defaultPatterns = [".env*"] as const

export type Limit = { readonly files: number; readonly bytes: number }

/**
 * The most a worktree gets. Patterns that pick more get nothing at all: part of a node_modules is
 * worse than none, and the answer says why.
 */
export const includeLimit: Limit = { files: 2_000, bytes: 512 * 1024 * 1024 }

/** How long one git run over the checkout may take, and how much of a listing is read. */
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
  /** The files picked but not copied: the worktree has one there, or the copy failed. */
  readonly failed: readonly string[]
  /** The patterns picked more than `includeLimit`, so nothing was copied. */
  readonly over?: true
  /** The patterns or the checkout's matching files couldn't be read, so nothing was copied. */
  readonly unread?: true
}

/** A pattern line of .gitignore's syntax, as git reads it from a file. */
type Pattern = { readonly text: string; readonly negated: boolean; readonly path: boolean }

/** The lines git reads as patterns, with Windows line ends and a byte order mark dropped. */
export const patternLines = (text: string): readonly string[] =>
  text
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "" && !line.startsWith("#"))

/**
 * Each line as a pattern: negated by a leading `!`, and a path where it has a `/` anywhere (a
 * trailing one names a folder). Trailing spaces go, as git drops them unless escaped.
 */
export const patternsOf = (lines: readonly string[]): readonly Pattern[] =>
  lines.map((line) => {
    const negated = line.startsWith("!")
    const text = (negated ? line.slice(1) : line).replace(/(?<!\\) +$/, "")
    return { text, negated, path: text.includes("/") }
  })

/** A character as itself in a regular expression. */
const literal = (char: string): string => char.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&")

/**
 * Whether a file's own name matches a pattern without a `/`, as git matches one: `*` and `?`
 * match any characters of a name, `[...]` is a class (`[!...]` negated), `\` escapes the next.
 */
export const nameMatches = (pattern: string, name: string): boolean => {
  let source = ""
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!
    if (char === "\\" && at + 1 < pattern.length) {
      at += 1
      source += literal(pattern[at]!)
    } else if (char === "*") source += ".*"
    else if (char === "?") source += "."
    else if (char === "[" && pattern.indexOf("]", at + 2) !== -1) {
      const end = pattern.indexOf("]", at + 2)
      const inside = pattern.slice(at + 1, end)
      const negated = inside.startsWith("!") || inside.startsWith("^")
      const body = (negated ? inside.slice(1) : inside)
        .replaceAll("\\", "\\\\")
        .replaceAll("]", "\\]")
      source += `[${negated ? "^" : ""}${body}]`
      at = end
    } else source += literal(char)
  }
  try {
    return new RegExp(`^${source}$`, "su").test(name)
  } catch {
    return false
  }
}

/** The paths of a NUL-ended listing, files only. */
const filesOf = (out: string): readonly string[] =>
  out.split("\0").filter((path) => path !== "" && !path.endsWith("/"))

/** The folders above a path, each with its trailing `/`: `a/b/c` has `a/` and `a/b/`. */
const foldersAbove = (path: string): readonly string[] => {
  const parts = path.split("/").slice(0, -1)
  return parts.map((_, at) => parts.slice(0, at + 1).join("/") + "/")
}

/** Shallowest first, then by path, so the answer names a top-level `.env` before deeper ones. */
const byDepth = (a: string, b: string): number =>
  a.split("/").length - b.split("/").length || (a < b ? -1 : a > b ? 1 : 0)

export type Picked =
  | { readonly ok: true; readonly paths: readonly string[] }
  | { readonly ok: false; readonly why: "unread" | "over" }

/**
 * The ignored files of `top` that the patterns pick, as `/` paths relative to it. A file counts
 * by a pattern that names a path (with a `/`, such as `certs/local/**` or `.venv/`), or by its own
 * name matching one that doesn't (`.env*`) outside any folder ignored as a whole: never by a
 * folder above it matching that one (a Python venv named `.env`), and never inside node_modules,
 * whose packages bring `.env` files of their own.
 */
export const pickedFiles = async (
  top: string,
  lines: readonly string[],
  limit: Limit = includeLimit,
): Promise<Picked> => {
  const patterns = patternsOf(lines)
  if (patterns.every((pattern) => pattern.negated)) return { ok: true, paths: [] }
  const names = patterns.filter((pattern) => !pattern.negated && !pattern.path)
  const byName = (path: string) =>
    names.some((pattern) => nameMatches(pattern.text, posix.basename(path)))
  const scratch = await mkdtemp(join(tmpdir(), "novadeck-include-"))
  try {
    const listed = async (
      chosen: readonly string[],
      name: string,
      keep?: (path: string) => boolean,
    ) => {
      const file = join(scratch, name)
      await writeFile(file, chosen.join("\n") + "\n")
      return git(top, ["ls-files", "-z", "--others", "--ignored", `--exclude-from=${file}`], {
        ...listing,
        ...(keep && { entries: keep }),
      })
    }
    // By name: every line, so its negations count, keeping the files whose own name matches.
    const all = names.length === 0 ? undefined : await listed(lines, "all", (path) => byName(path))
    // By path: the lines with a `/`, and the negations that may undo some of them.
    const pathLines = lines.filter((_, at) => patterns[at]!.negated || patterns[at]!.path)
    const byPath = patterns.some((pattern) => pattern.path && !pattern.negated)
      ? await listed(pathLines, "paths")
      : undefined
    for (const run of [all, byPath]) {
      if (run === undefined) continue
      if (!run.ok) return { ok: false, why: "unread" }
      // Past four megabytes of paths, it is far past the limit.
      if (run.cut) return { ok: false, why: "over" }
    }
    const named = all?.ok ? filesOf(all.out) : []
    const pathed = byPath?.ok ? filesOf(byPath.out) : []
    if (named.length + pathed.length === 0) return { ok: true, paths: [] }
    // The folders git ignores as a whole: listed as one, with nothing of theirs listed apart. A
    // folder whose files git lists too (one that ignores itself by its own `*`) isn't one. Only
    // folders are kept, so loose ignored files, however many, never fill the listing.
    const listedApart = new Set<string>()
    const ignored = await git(
      top,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"],
      {
        ...listing,
        entries: (path) => {
          if (path.endsWith("/")) return true
          for (const folder of foldersAbove(path)) listedApart.add(folder)
          return false
        },
      },
    )
    if (!ignored.ok || ignored.cut) return { ok: false, why: "unread" }
    const whole = new Set(
      ignored.out.split("\0").filter((path) => path.endsWith("/") && !listedApart.has(path)),
    )
    const inWhole = (path: string) => foldersAbove(path).some((folder) => whole.has(folder))
    const chosen = [...new Set([...named.filter((path) => !inWhole(path)), ...pathed])]
    if (chosen.length === 0) return { ok: true, paths: [] }
    // Only what git ignores: a pattern may also match an untracked file it doesn't. Git lists
    // every ignored file, folders' too, and only the chosen ones are kept as it goes.
    const wanted = new Set(chosen)
    const checked = await git(
      top,
      ["ls-files", "-z", "--others", "--ignored", "--exclude-standard"],
      { ...listing, entries: (path) => wanted.has(path) },
    )
    if (!checked.ok || checked.cut) return { ok: false, why: "unread" }
    const kept = filesOf(checked.out)
    if (kept.length > limit.files) return { ok: false, why: "over" }
    return { ok: true, paths: kept.toSorted(byDepth) }
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** The patterns to copy, or no lines if an existing .worktreeinclude can't be read. */
const patternsAt = async (
  top: string,
): Promise<{ readonly by: Included["by"]; readonly lines?: readonly string[] }> => {
  try {
    return { by: "file", lines: patternLines(await readFile(join(top, includeFile), "utf8")) }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { by: "default", lines: defaultPatterns }
    return { by: "file" }
  }
}

/** What a path reaches, followed through links; undefined where it reaches nothing. */
const reaches = (path: string) =>
  stat(path).then(
    (found) => found,
    () => undefined,
  )

/**
 * Copies one file as it is: a symlink as a symlink (a relative one that reaches nothing from the
 * worktree points absolutely at what it reached from the checkout), a file as a copy-on-write clone where the
 * file system makes one (APFS, btrfs, XFS, ReFS) and a copy elsewhere. Never over a file the
 * worktree has. False where it wasn't copied.
 */
const copyOne = async (from: string, to: string): Promise<boolean> => {
  try {
    const info = await lstat(from)
    await mkdir(dirname(to), { recursive: true })
    if (info.isSymbolicLink()) {
      const target = await readlink(from)
      const reached = isAbsolute(target) ? target : resolve(dirname(from), target)
      // Relative, it stays so where it reaches a file from the worktree too (one the worktree
      // has, or the same one); else it points at what it reached from the checkout.
      const fromWorktree = isAbsolute(target)
        ? undefined
        : await reaches(resolve(dirname(to), target))
      const found = fromWorktree ?? (await reaches(reached))
      await symlink(
        isAbsolute(target) || fromWorktree !== undefined ? target : reached,
        to,
        found?.isDirectory() ? "dir" : "file",
      )
      return true
    }
    if (!info.isFile()) return false
    await copyFile(from, to, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE)
    return true
  } catch {
    return false
  }
}

/** Whether the files' sizes, summed, keep to the limit. */
const fits = async (top: string, paths: readonly string[], limit: Limit): Promise<boolean> => {
  const sizes = await Promise.all(
    paths.map((path) =>
      lstat(join(top, path)).then(
        (info) => info.size,
        () => 0,
      ),
    ),
  )
  return sizes.reduce((sum, size) => sum + size, 0) <= limit.bytes
}

/**
 * Gives a new worktree the ignored files of the checkout it was made from that the patterns pick.
 * It never fails the open: whatever goes wrong is said in what it answers.
 */
export const copyIncluded = async (
  top: string,
  worktree: string,
  limit: Limit = includeLimit,
): Promise<Included> => {
  const { by, lines } = await patternsAt(top)
  const none = { from: top, by, copied: [], failed: [] } as const
  if (lines === undefined) return { ...none, unread: true }
  try {
    const picked = await pickedFiles(top, lines, limit)
    if (!picked.ok)
      return picked.why === "over" ? { ...none, over: true } : { ...none, unread: true }
    if (!(await fits(top, picked.paths, limit))) return { ...none, over: true }
    const copied: string[] = []
    const failed: string[] = []
    for (let at = 0; at < picked.paths.length; at += together) {
      const batch = picked.paths.slice(at, at + together)
      // eslint-disable-next-line no-await-in-loop -- A few at a time, so a long list doesn't open every file at once.
      const done = await Promise.all(
        batch.map((path) => copyOne(join(top, path), join(worktree, ...path.split("/")))),
      )
      for (const [index, path] of batch.entries()) (done[index] ? copied : failed).push(path)
    }
    return { ...none, copied, failed }
  } catch {
    // A temporary folder that can't be made, say: the worktree stands without the files.
    return { ...none, unread: true }
  }
}
