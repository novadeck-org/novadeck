import { existsSync } from "node:fs"
import { join } from "node:path"

import { git as realGit, gitScope } from "../checkouts/git.js"
import { behindMain } from "../checkouts/repository.js"
import { said } from "./repo.js"

// Moving a repository's own checkout to the remote's main, when that is safe: a fast-forward and
// nothing else, which touches no file the person changed.

/** What a git folder holds while an operation is half done, and the operation it is. */
const operations: readonly (readonly [string, string])[] = [
  ["MERGE_HEAD", "a merge"],
  ["CHERRY_PICK_HEAD", "a cherry-pick"],
  ["REVERT_HEAD", "a revert"],
  ["rebase-merge", "a rebase"],
  ["rebase-apply", "a rebase"],
  ["BISECT_LOG", "a bisect"],
  ["sequencer", "a cherry-pick or revert"],
]

/** A git run that may be slow on a big repository or a loaded machine. */
const patient = { cap: 64 * 1024, ms: 60_000 }
const small = { cap: 4096 }
/** A run that is never timed out: as long as a timer can be (about 24 days). */
const untimed = 2 ** 31 - 1

export type FastForward = {
  readonly run?: typeof realGit
  /** An empty folder, so no hook of the repository runs; asked for only when a checkout moves. */
  readonly hooks: () => Promise<string>
  readonly env?: NodeJS.ProcessEnv
  /** Tracked changes don't hold it back (git still refuses where one is in the way). */
  readonly allowChanges?: boolean
}

export type Forwarded =
  | { readonly ok: true; readonly moved: boolean }
  | { readonly ok: false; readonly said: string }

/** Why the checkout can't move now: an operation in progress or a lock, else undefined. */
export const operationIn = async (
  home: string,
  run: typeof realGit = realGit,
): Promise<string | undefined> => {
  const dir = await run(home, ["rev-parse", "--absolute-git-dir"], small)
  if (!dir.ok) return said(dir)
  const folder = dir.out.trim()
  for (const [name, what] of operations)
    if (existsSync(join(folder, name)))
      return `${what[0]!.toUpperCase()}${what.slice(1)} is in progress.`
  if (existsSync(join(folder, "index.lock"))) return "Another git command is running here."
  return undefined
}

/**
 * Whether tracked files differ from HEAD, staged or not; untracked files don't count, as git
 * refuses to overwrite one. Reads only (no index refresh), so it never takes the lock the
 * person's own git needs. Undefined where git can't tell.
 */
export const trackedChanges = async (
  home: string,
  run: typeof realGit = realGit,
): Promise<boolean | undefined> => {
  const status = await run(
    home,
    [
      "--no-optional-locks",
      "status",
      "--porcelain=v1",
      "--untracked-files=no",
      "--ignore-submodules",
    ],
    patient,
  )
  return status.ok ? status.out.trim() !== "" : undefined
}

/**
 * Moves the repository's own checkout (`home`, never a linked worktree) to the remote's main
 * when it is on the branch main is and strictly behind it, with `git merge --ff-only` to the
 * very commit that was checked, hooks off. Without `allowChanges` it also waits for a checkout
 * with no tracked changes and no operation in progress. Never throws.
 */
export const fastForward = async (home: string, options: FastForward): Promise<Forwarded> => {
  const run = options.run ?? realGit
  const behind = await behindMain(home)
  if (behind === undefined) return { ok: true, moved: false }
  const working = await run(home, ["rev-parse", "--is-inside-work-tree"], small)
  if (!working.ok || working.out.trim() !== "true") return { ok: true, moved: false }
  const operation = await operationIn(home, run)
  if (operation !== undefined) return { ok: false, said: operation }
  if (options.allowChanges !== true) {
    const changed = await trackedChanges(home, run)
    if (changed !== false)
      return { ok: false, said: changed ? "It has changes of its own." : "Git couldn't read it." }
  }
  // A user's checkout or commit in the moment since: HEAD must be as it was checked.
  const still = await run(home, ["rev-parse", "--verify", "-q", "HEAD^{commit}"], small)
  const branch = await run(home, ["symbolic-ref", "-q", "HEAD"], small)
  if (
    !still.ok ||
    still.out.trim() !== behind.head ||
    !branch.ok ||
    branch.out.trim() !== `refs/heads/${behind.branch}`
  )
    return { ok: true, moved: false }
  // No time limit, and outside any scope that ends git runs: a merge stopped halfway through
  // its checkout leaves a half-updated tree, so it is let finish.
  const hooks = await options.hooks()
  const merged = await gitScope.exit(() =>
    run(
      home,
      [
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "core.fsmonitor=false",
        "-c",
        "merge.autoStash=false",
        "merge",
        "--ff-only",
        "--no-verify-signatures",
        "--no-overwrite-ignore",
        "--quiet",
        "--no-edit",
        behind.commit,
      ],
      { cap: 64 * 1024, ms: untimed, env: { GIT_MERGE_AUTOEDIT: "no", ...options.env } },
    ),
  )
  return merged.ok ? { ok: true, moved: true } : { ok: false, said: said(merged) }
}
