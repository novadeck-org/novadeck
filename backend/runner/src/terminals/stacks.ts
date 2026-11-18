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

/** What the stacks are read with: git's answers about ancestry, and which branch is the default. */
export type Ancestry = {
  /** Whether `commit` is an ancestor of `ref` (or is it) in the repository at `cwd`. */
  readonly within: (cwd: string, commit: string, ref: string) => Promise<boolean>
  /** The repository's default branch as refs, local and remote-tracking: where finished work lies. */
  readonly defaults: (cwd: string) => Promise<readonly string[]>
}

/** How long an answer is trusted once read, in milliseconds. */
const trustedMs = 10_000

/**
 * How many answers are kept: a session of about 20 terminals with 3 worktrees each asks of
 * about 60 worktrees, each against 60, so the cache holds more than one listing asks.
 */
const keptAnswers = 8192

/** Reads ancestry with git, remembering each answer briefly so a listing reads few. */
export const gitAncestry = (now: () => number = Date.now): Ancestry => {
  const known = new Map<string, { readonly at: number; readonly answer: unknown }>()
  const remembered = async <T>(key: string, read: () => Promise<T>): Promise<T> => {
    const seen = known.get(key)
    if (seen && now() - seen.at < trustedMs) return seen.answer as T
    const answer = await read()
    known.set(key, { at: now(), answer })
    // A repository with many worktrees asked of often should not grow this without end.
    if (known.size > keptAnswers) known.delete(known.keys().next().value!)
    return answer
  }
  return {
    within: (cwd, commit, ref) =>
      remembered(
        `within\0${cwd}\0${commit}\0${ref}`,
        async () =>
          (await git(cwd, ["merge-base", "--is-ancestor", commit, ref], { cap: 1024 })).ok,
      ),
    defaults: (cwd) =>
      remembered(`defaults\0${cwd}`, async () => {
        const head = await git(cwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], {
          cap: 1024,
        })
        const remote = head.ok ? head.out.trim() : ""
        const name = remote.replace(/^refs\/remotes\/[^/]+\//, "")
        return remote.startsWith("refs/remotes/") && name !== ""
          ? [remote, `refs/heads/${name}`]
          : [
              "refs/heads/main",
              "refs/heads/master",
              "refs/remotes/origin/main",
              "refs/remotes/origin/master",
            ]
      }),
  }
}

/**
 * Whose work is based on another terminal's, by terminal: a worktree whose pull request targets
 * another terminal's branch, or one started from a commit that lies inside another terminal's
 * branch and not in the repository's default branch, so from work not yet there (a branch that
 * merged the default branch's newer commits in doesn't make the worktrees opened from them its
 * dependents). Both are facts Novadeck reads; neither says anyone must wait.
 */
export const stacksOf = async (
  terminals: readonly StackTerminal[],
  ancestry: Ancestry,
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
    for (const own of mine.worktrees) {
      // Whether its base lies in the default branch, read once for it, and only when a pair asks.
      let off: Promise<boolean> | undefined
      const offDefault = (): Promise<boolean> =>
        (off ??= ancestry.defaults(own.path).then(async (refs) => {
          const inDefault = await Promise.all(
            refs.map((ref) => ancestry.within(own.path, own.base!, ref)),
          )
          return !inDefault.some(Boolean)
        }))
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
          if (own.base === undefined || own.base === there.base) continue
          checks.push(
            (async () => {
              if (!(await offDefault())) return
              if (await ancestry.within(there.path, own.base!, there.branch))
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
    }
  await Promise.all(checks)
  return found
}
