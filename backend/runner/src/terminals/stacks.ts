import { git } from "../checkouts/git.js"
import type { CiPullRequest, Stack } from "../messaging/coordination.js"

/** A terminal's worktrees, as the facts on whose work is based on whose read them. */
export type StackTerminal = {
  readonly terminalId: string
  readonly handle: string
  readonly worktrees: readonly {
    readonly path: string
    readonly branch: string
    readonly commonDir?: string | undefined
    /** The commit it started from. */
    readonly base?: string | undefined
    readonly pullRequest?: CiPullRequest | undefined
  }[]
}

/** Whether `commit` is an ancestor of `ref` (or is it) in the repository at `cwd`. */
export type Ancestor = (cwd: string, commit: string, ref: string) => Promise<boolean>

/** How long an ancestry answer is trusted once read, in milliseconds. */
const trustedMs = 10_000

/** Reads ancestry with git, remembering each answer briefly so a listing reads few. */
export const gitAncestry = (now: () => number = Date.now): Ancestor => {
  const known = new Map<string, { readonly at: number; readonly answer: boolean }>()
  return async (cwd, commit, ref) => {
    const key = `${cwd}\0${commit}\0${ref}`
    const seen = known.get(key)
    if (seen && now() - seen.at < trustedMs) return seen.answer
    const ran = await git(cwd, ["merge-base", "--is-ancestor", commit, ref], { cap: 1024 })
    known.set(key, { at: now(), answer: ran.ok })
    // A repository with many worktrees asked of often should not grow this without end.
    if (known.size > 512) known.delete(known.keys().next().value!)
    return ran.ok
  }
}

/**
 * Whose work is based on another terminal's, by terminal: a worktree whose pull request targets
 * another terminal's branch, or one started from a commit that lies inside another terminal's
 * branch (from after the commit that branch itself started from), so from work not yet in the
 * default branch. Both are facts Novadeck reads; neither says anyone must wait.
 */
export const stacksOf = async (
  terminals: readonly StackTerminal[],
  ancestor: Ancestor,
): Promise<ReadonlyMap<string, readonly Stack[]>> => {
  const found = new Map<string, Stack[]>()
  const note = (terminalId: string, stack: Stack): void => {
    const list = found.get(terminalId) ?? []
    if (
      !list.some((each) => each.onTerminalId === stack.onTerminalId && each.branch === stack.branch)
    )
      found.set(terminalId, [...list, stack])
  }
  const checks: Promise<void>[] = []
  for (const mine of terminals)
    for (const own of mine.worktrees)
      for (const other of terminals) {
        if (other.terminalId === mine.terminalId) continue
        for (const there of other.worktrees) {
          if (there.commonDir !== undefined && own.commonDir !== there.commonDir) continue
          if (there.branch === own.branch) continue
          const target = own.pullRequest?.base
          if (target !== undefined && target === there.branch) {
            note(mine.terminalId, {
              onTerminalId: other.terminalId,
              onHandle: other.handle,
              branch: there.branch,
              via: "pull-request",
              pull: own.pullRequest!.number,
            })
            continue
          }
          if (own.base === undefined || there.base === undefined || own.base === there.base)
            continue
          checks.push(
            (async () => {
              const [within, before] = await Promise.all([
                ancestor(there.path, own.base!, there.branch),
                ancestor(there.path, own.base!, there.base!),
              ])
              if (within && !before)
                note(mine.terminalId, {
                  onTerminalId: other.terminalId,
                  onHandle: other.handle,
                  branch: there.branch,
                  via: "commits",
                })
            })(),
          )
        }
      }
  await Promise.all(checks)
  return found
}
