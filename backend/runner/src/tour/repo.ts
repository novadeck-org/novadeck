import { existsSync } from "node:fs"
import { appendFile, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

import { git, type Run } from "../checkouts/git.js"
import { DomainError } from "../errors.js"
import { tourMarker } from "./folder.js"

// The tour's folder as a tiny git repository, so its agents work in worktrees of it as they
// do in the person's own code. Git is run as the person would, but with the identity given
// per command, never written to their git config.

const small = { cap: 64 * 1024, ms: 30_000 }

const needsGit = "The tour needs git, which isn't installed here. Install git, then take the tour."
const brokenGit =
  "The tour needs git, which didn't answer here. Check that git works, then take the tour."

const said = (run: Run): string =>
  run.ok ? "" : run.kind === "no-git" ? needsGit : run.said || `git ${run.kind}`

/**
 * Refuses, as `commitSandbox` would, where git isn't there or doesn't run (macOS' stub without
 * the Command Line Tools finds but fails), before the tour changes anything.
 */
export const requireGit = async (): Promise<void> => {
  const run = await git(tmpdir(), ["--version"], small)
  if (!run.ok) throw new DomainError("CONFLICT", run.kind === "timeout" ? brokenGit : needsGit)
}

// What the repo's `.git/info/exclude` keeps out for the tour: its marker, and the Claude Code
// settings it lays over the project (`laySandbox`). `releaseSandbox` takes both lines out again.
const excluded = [tourMarker, ".claude/settings.json"]

/**
 * Makes the folder, whose files are all written, a repository on `main` with one commit of
 * them, never the tour's own files (`excluded`), which `.git/info/exclude` keeps out. What is
 * committed is the project as the person keeps it. The commit is the tour's own (`Novadeck
 * tour`), unsigned and with no hooks, and what it takes in is the folder's files and the seed's
 * own `.gitignore` alone: the person's global ignore file (`core.excludesFile`) doesn't leave a
 * file of the seed out.
 */
export const commitSandbox = async (folder: string): Promise<void> => {
  const step = async (args: readonly string[]): Promise<void> => {
    const run = await git(folder, args, small)
    if (!run.ok)
      throw new DomainError("CONFLICT", `The tour couldn't set up its repo: ${said(run)}`)
  }
  // `init` then `symbolic-ref`: `init -b` needs git 2.28.
  await step(["init"])
  await step(["symbolic-ref", "HEAD", "refs/heads/main"])
  await mkdir(join(folder, ".git", "info"), { recursive: true })
  // An empty folder for hooks, so none of the person's (global `core.hooksPath`) runs.
  await mkdir(join(folder, ".git", "no-hooks"), { recursive: true })
  await appendFile(join(folder, ".git", "info", "exclude"), `${excluded.join("\n")}\n`)
  await commitAll(folder, "Start the tour's repo", step)
}

// Stages every file of the folder and commits them as the tour (`Novadeck tour`), unsigned and
// with no hooks (the repo's own empty folder of them, `.git/no-hooks`).
const commitAll = async (
  folder: string,
  message: string,
  step: (args: readonly string[]) => Promise<void>,
): Promise<void> => {
  const plain = ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false"]
  await step([...plain, "-c", "core.excludesFile=", "add", "--all"])
  await step([
    "-c",
    "user.name=Novadeck tour",
    "-c",
    "user.email=tour@novadeck.invalid",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "tag.gpgsign=false",
    "-c",
    `core.hooksPath=${join(folder, ".git", "no-hooks")}`,
    ...plain,
    "commit",
    "--no-verify",
    "--message",
    message,
  ])
}

// Lists of files, which a game's folder keeps short.
const listing = { cap: 4 * 1024 * 1024, ms: 30_000 }

// The paths of a git listing of NUL-ended names.
const names = (run: Run): string[] => (run.ok ? run.out.split("\0").filter(Boolean) : [])

// The other worktrees of the folder's repository, by top folder, those still on the disk.
const worktreesOf = async (folder: string): Promise<string[]> => {
  const run = await git(folder, ["worktree", "list", "--porcelain"], listing)
  if (!run.ok) return []
  const paths = run.out
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length))
  // The first is the folder itself.
  return paths.slice(1).filter((path) => existsSync(path))
}

// The files `folder` changed since `base`, as the dev server (the seed's dev.mjs) counts them:
// those that differ from that commit, and those git doesn't track and doesn't ignore.
const changedSince = async (folder: string, base: string): Promise<Set<string>> =>
  new Set([
    ...names(await git(folder, ["diff", "--name-only", "-z", base], listing)),
    ...names(await git(folder, ["ls-files", "--others", "--exclude-standard", "-z"], listing)),
  ])

// When the file at `path` last changed, or undefined where there is no file.
const changedAt = async (path: string): Promise<number | undefined> => {
  const found = await stat(path).catch(() => undefined)
  return found?.isFile() ? found.mtimeMs : undefined
}

/**
 * Brings the tour's work home, for the person who keeps the project: the folder ends up holding
 * what the dev server (the seed's `dev.mjs`) last served, committed on `main` as "The team's
 * game". Each worktree's files that it changed since it parted from the folder are laid over
 * the folder, the newest copy of each where several changed one (the folder's own among them
 * where it changed it too), as the dev server picks them; a file a worktree removed stays, as
 * the dev server serves the folder's. Then each worktree is moved to that commit (`reset
 * --hard`), so it holds nothing main doesn't and the Worktrees panel shows its work merged. No
 * agent runs git for any of it. Where the folder is no repo, nothing happens; where a step of
 * git fails, a `CONFLICT` says so.
 */
export const bringHome = async (folder: string): Promise<void> => {
  if (!existsSync(join(folder, ".git"))) return
  const step = async (args: readonly string[], at = folder): Promise<void> => {
    const run = await git(at, args, small)
    if (!run.ok)
      throw new DomainError("CONFLICT", `The tour couldn't keep the team's work: ${said(run)}`)
  }
  const head = await git(folder, ["rev-parse", "HEAD"], small)
  if (!head.ok) return
  const others = await worktreesOf(folder)
  // What each worktree changed, and what the folder changed since the same commit.
  const changes = await Promise.all(
    others.map(async (worktree) => {
      const parted = await git(worktree, ["merge-base", "HEAD", head.out.trim()], small)
      const base = parted.ok ? parted.out.trim() : "HEAD"
      return {
        worktree,
        theirs: await changedSince(worktree, base),
        ours: await changedSince(folder, base),
      }
    }),
  )
  const files = new Set(changes.flatMap(({ theirs }) => [...theirs]))
  await Promise.all(
    [...files].map(async (name) => {
      const own = join(folder, name)
      const copies = changes
        .filter(({ theirs }) => theirs.has(name))
        .map(({ worktree }) => join(worktree, name))
      if (changes.some(({ theirs, ours }) => theirs.has(name) && ours.has(name))) copies.push(own)
      const dated = await Promise.all(
        copies.map(async (path) => ({ path, at: await changedAt(path) })),
      )
      const newest = dated
        .filter((copy): copy is { path: string; at: number } => copy.at !== undefined)
        .toSorted((a, b) => b.at - a.at)[0]
      if (newest === undefined || newest.path === own) return
      await mkdir(dirname(own), { recursive: true })
      await copyFile(newest.path, own)
    }),
  )
  const status = await git(folder, ["status", "--porcelain"], listing)
  if (status.ok && status.out.trim() !== "") await commitAll(folder, "The team's game", step)
  const kept = await git(folder, ["rev-parse", "HEAD"], small)
  if (!kept.ok) return
  for (const worktree of others)
    // eslint-disable-next-line no-await-in-loop -- One worktree at a time: they share the repo's lock.
    await step(["reset", "--quiet", "--hard", kept.out.trim()], worktree)
}

// The files of `names` that the folder's repo tracks.
const tracked = async (folder: string, names: readonly string[]): Promise<string[]> => {
  const run = await git(folder, ["ls-files", "-z", "--", ...names], small)
  return run.ok ? run.out.split("\0").filter(Boolean) : []
}

/**
 * Lays the tour's own `files` (the sandbox's rules, its Claude Code settings) over the committed
 * project, where git doesn't see them: each is written, and one the commit holds is marked
 * `skip-worktree`, so `git status` stays clean and a worktree made from the commit has the
 * project's own file. The others are kept out by `.git/info/exclude` (`excluded`).
 */
export const laySandbox = async (
  folder: string,
  files: Readonly<Record<string, string>>,
): Promise<void> => {
  await Promise.all(
    Object.entries(files).map(async ([name, text]) => {
      await mkdir(dirname(join(folder, name)), { recursive: true })
      await writeFile(join(folder, name), text)
    }),
  )
  const held = await tracked(folder, Object.keys(files))
  if (held.length === 0) return
  const run = await git(folder, ["update-index", "--skip-worktree", "--", ...held], small)
  if (!run.ok) throw new DomainError("CONFLICT", `The tour couldn't set up its repo: ${said(run)}`)
}

/**
 * The reverse of `laySandbox`, for the project the person keeps: `AGENTS.md` is `note` again,
 * the project's own, with no `skip-worktree` bit, and the tour's lines are out of
 * `.git/info/exclude`, so a `.claude/settings.json` the person adds later isn't ignored. Where
 * the folder is no repo (it was removed) only the note is written. Safe to repeat.
 */
export const releaseSandbox = async (folder: string, note: string): Promise<void> => {
  await writeFile(join(folder, "AGENTS.md"), note)
  if (!existsSync(join(folder, ".git"))) return
  const held = await tracked(folder, ["AGENTS.md"])
  if (held.length > 0) {
    const run = await git(folder, ["update-index", "--no-skip-worktree", "--", ...held], small)
    if (!run.ok) throw new DomainError("CONFLICT", `The tour couldn't keep its repo: ${said(run)}`)
  }
  const file = join(folder, ".git", "info", "exclude")
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return
  const lines = text.split("\n").filter((line) => !excluded.includes(line))
  await writeFile(file, lines.join("\n"))
}
