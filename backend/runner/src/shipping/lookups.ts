/**
 * What the shipping gate's reader asks of git and of the runner's worktree records: a checkout's
 * branch and upstream, its repository's identity, and whether a branch is the agent's own.
 * Every lookup runs git as the runner does (no hooks, no pager) and never changes anything.
 */
import { git } from "../checkouts/git.js"
import { currentBranch, keysOf } from "../checkouts/home.js"
import { commonDir } from "../checkouts/repository.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { mainName } from "../worktrees/worktrees.js"
import type { Lookups } from "./reader.js"

const small = { cap: 64 * 1024 }

const out = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
  const run = await git(cwd, args, small)
  return run.ok ? run.out.trim() || undefined : undefined
}

/** `owner/repo` of a GitHub-style remote URL, else undefined. */
export const repoOfUrl = (url: string): string | undefined =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]

/** Whether git accepts `name` as the name of a branch or a remote (`git check-ref-format`). */
export const validName = async (cwd: string, name: string): Promise<boolean> =>
  !name.startsWith("-") &&
  !name.includes("\n") &&
  (await git(cwd, ["check-ref-format", `refs/heads/${name}`], small)).ok

/** The repository's default branch as `origin/HEAD` says, where it is set. */
export const defaultOf = async (cwd: string): Promise<string | undefined> =>
  (await out(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]))?.replace(
    /^origin\//,
    "",
  )

/** The worktrees the gate asks the runner's records about. */
export type Owned = {
  /** The tracked worktrees of the terminal, and of every terminal. */
  readonly ofTerminal: (terminalId: string) => readonly WorktreeRecord[]
  readonly all: () => readonly WorktreeRecord[]
}

export const gitLookups = (terminalId: string, owned: Owned): Lookups => ({
  branch: (cwd) => currentBranch(cwd),
  upstream: async (cwd, branch) => {
    const remote = await out(cwd, ["config", "--get", `branch.${branch}.remote`])
    const merge = await out(cwd, ["config", "--get", `branch.${branch}.merge`])
    return remote !== undefined && merge !== undefined
      ? { remote, branch: merge.replace(/^refs\/heads\//, "") }
      : undefined
  },
  repo: async (cwd) => {
    const url = await out(cwd, ["remote", "get-url", "origin"])
    const named = url === undefined ? undefined : repoOfUrl(url)
    if (named !== undefined) return named
    const common = await commonDir(cwd)
    return typeof common === "string" ? common : undefined
  },
  own: async (cwd, branch) => {
    // Of this repository, by its git common dir: another repository's branch of the same
    // name is no worktree of the agent's here.
    const common = await commonDir(cwd)
    if (common === undefined) return false
    if (
      !owned.ofTerminal(terminalId).some((row) => row.branch === branch && row.commonDir === common)
    )
      return false
    // Never a worktree's home: other agents build on it. Each tracked worktree's home is its
    // branch's own key, else the repository's main: the keys are read once for all of them.
    const rows = owned.all().filter((row) => row.commonDir === common)
    const keys = await keysOf(cwd)
    if (rows.some((row) => keys.get(row.branch)?.home === branch)) return false
    return !(
      rows.some((row) => keys.get(row.branch)?.home === undefined) &&
      (await mainName(cwd)) === branch
    )
  },
})
