import { mkdir, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { git, type Run } from "../checkouts/git.js"
import { DomainError } from "../errors.js"
import { tourMarker } from "./folder.js"

// The tour's folder as a tiny git repository, so its agents work in worktrees of it as they
// do in the person's own code. Git is run as the person would, but with the identity given
// per command, never written to their git config.

const small = { cap: 64 * 1024, ms: 30_000 }

const needsGit = "The tour needs git, which isn't installed here. Install git, then take the tour."

const said = (run: Run): string =>
  run.ok ? "" : run.kind === "no-git" ? needsGit : run.said || `git ${run.kind}`

/**
 * Refuses, as `commitSandbox` would, where git isn't there or doesn't run (macOS' stub without
 * the Command Line Tools finds but fails), before the tour changes anything.
 */
export const requireGit = async (): Promise<void> => {
  const run = await git(tmpdir(), ["--version"], small)
  if (!run.ok) throw new DomainError("CONFLICT", needsGit)
}

/**
 * Makes the folder, whose files are all written, a repository on `main` with one commit of
 * them, never its marker, which `.git/info/exclude` keeps out. The commit is the tour's own
 * (`Novadeck tour`), unsigned and with no hooks, whatever the person's git settings say.
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
  await appendFile(join(folder, ".git", "info", "exclude"), `${tourMarker}\n`)
  await step(["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "add", "--all"])
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
