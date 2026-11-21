/**
 * What the shipping gate's reader asks of git and of the runner's worktree records: a checkout's
 * branch and upstream, its repository's identity, and whether a branch is the agent's own.
 * Every lookup runs git as the runner does (no hooks, no pager) and never changes anything.
 */
import { stat } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

import { git } from "../checkouts/git.js"
import { currentBranch } from "../checkouts/home.js"
import { commonDir } from "../checkouts/repository.js"
import type { WorktreeRecord } from "../worktrees/records.js"
import { homeSaid } from "../worktrees/worktrees.js"
import type { Lookups } from "./reader.js"

const small = { cap: 64 * 1024 }

const out = async (cwd: string, args: readonly string[]): Promise<string | undefined> => {
  const run = await git(cwd, args, small)
  return run.ok ? run.out.trim() || undefined : undefined
}

/** `owner/repo` of a GitHub-style remote URL, else undefined. */
export const repoOfUrl = (url: string): string | undefined =>
  /[:/]([^/:]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.[1]

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
  own: async (_cwd, branch) => {
    const mine = owned.ofTerminal(terminalId).filter((row) => row.branch === branch)
    if (mine.length === 0) return false
    // Never a worktree's home: other agents build on it.
    const homes = await Promise.all(
      owned
        .all()
        .map(async (row) =>
          (await exists(row.path)) ? await homeSaid(row.path, row.branch) : undefined,
        ),
    )
    return !homes.includes(branch)
  },
})

const exists = async (path: string): Promise<boolean> =>
  (await stat(isAbsolute(path) ? path : join(path)).catch(() => undefined)) !== undefined
