import { existsSync } from "node:fs"
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
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
  const hooks = join(folder, ".git", "no-hooks")
  await mkdir(hooks, { recursive: true })
  await appendFile(join(folder, ".git", "info", "exclude"), `${excluded.join("\n")}\n`)
  await step([
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "-c",
    "core.excludesFile=",
    "add",
    "--all",
  ])
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
    `core.hooksPath=${hooks}`,
    "-c",
    "core.autocrlf=false",
    "-c",
    "core.safecrlf=false",
    "commit",
    "--no-verify",
    "--message",
    "Start the tour's repo",
  ])
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
