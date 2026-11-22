import { readFile } from "node:fs/promises"
import { join } from "node:path"

import { git } from "../checkouts/git.js"

const small = { cap: 64 * 1024 }
// A branch's reflog is a line per move, some 150 bytes each: far more than a landing's age.
const kept = 2 * 1024 * 1024
// The newest landings by that name that are tried: a name reused over and over is not worth more.
const tried = 5

/** One move of a branch, as its reflog says: what it was, what it became, what git said it was. */
type Move = { readonly old: string; readonly next: string; readonly subject: string }

/**
 * A branch's reflog (`<common>/logs/refs/heads/<name>`, one move per line: `old new ident\tsubject`),
 * newest first; none where it has none (reflogs can be off, expired or gone with a ref store that
 * keeps them elsewhere), which is not an error.
 */
const movesOf = async (common: string, name: string): Promise<readonly Move[]> => {
  const text = await readFile(join(common, "logs", "refs", "heads", name), "utf8").catch(
    () => undefined,
  )
  if (text === undefined) return []
  const lines = text.slice(-kept).split("\n")
  const moves: Move[] = []
  for (let at = lines.length - 1; at >= 0; at -= 1) {
    const line = lines[at]!
    const tab = line.indexOf("\t")
    const [old, next] = line.slice(0, tab).split(" ")
    if (tab === -1 || old === undefined || next === undefined || !/^[0-9a-f]{40,64}$/.test(next))
      continue
    moves.push({ old, next, subject: line.slice(tab + 1) })
  }
  return moves
}

/**
 * What git writes when a branch is merged into the one it is on, as `git merge` and `git pull .`
 * log it: `merge <what was typed>: Fast-forward` or `…: Merge made by the 'ort' strategy.`, and
 * `pull <arguments>: …` likewise. Not `merge --squash` (a plain commit), `reset`, `update-ref` or
 * a rebase's own moves, which name no merge. What was typed is whatever the person wrote.
 */
const merging = /^(merge|pull) (.*?): (?:Fast-forward|Merge made by)/

/** Whether `typed` (an argument of a merge) names the branch or its tip as it was. */
const names = (typed: string, branch: string, head: string): boolean => {
  const bare = typed.replace(/(?:~0|\^0|\^\{commit\})$/, "")
  return (
    bare === branch ||
    bare === `refs/heads/${branch}` ||
    bare === `heads/${branch}` ||
    (/^[0-9a-f]{7,64}$/.test(bare) && head.startsWith(bare))
  )
}

/** Whether `a` is an ancestor of `b` (or the same); false too where git couldn't say. */
const within = async (root: string, a: string, b: string): Promise<boolean> =>
  (await git(root, ["merge-base", "--is-ancestor", a, b], small)).ok

/**
 * Whether the branch `branch`, now at `head`, was landed by git: a merge into one of the local
 * branches `holders` (home, home's upstream's local side, the repository's main) logged in its
 * reflog as naming this branch, which brought `head` in (the merge's result holds it, the branch
 * before did not) and which the branch still holds. That is git's own record of a merge, a
 * fast-forward one too, which the history alone can't tell from a branch that caught up.
 *
 * Precision first: a branch that only caught up has its home's name in no merge line, so it reads
 * as it did; and what the reflog can't say reads as not landed: no reflog, an expired or pruned
 * entry, a merge whose line names something else (`merge --squash` writes a plain commit; a squash
 * is the history check's, by content), or a branch landed in another repository's branch. Git
 * runs only for a line that names the branch, so a work with no candidate costs a file read.
 * `start` is the commit the work started from: a branch still at it has done nothing to land.
 */
export const landedByReflog = async (
  root: string,
  common: string | undefined,
  holders: readonly string[],
  branch: string | null,
  head: string,
  start: string | undefined,
): Promise<boolean> => {
  if (common === undefined || branch === null || head === start) return false
  const locals = new Set(holders.flatMap((name) => [name, name.replace(/^origin\//, "")]))
  for (const local of locals) {
    // A branch isn't landed in itself.
    if (local === branch) continue
    // eslint-disable-next-line no-await-in-loop -- Few holders, the first that proves it.
    const moves = await movesOf(common, local)
    const candidates = moves
      .filter(({ subject }) => {
        const found = merging.exec(subject)
        if (!found) return false
        const typed = found[2]!.split(/\s+/)
        // `git pull origin x` merges a remote's branch, not this one: only `pull . x` does.
        if (found[1] === "pull" && !typed.includes(".")) return false
        return typed.some((each) => names(each, branch, head))
      })
      .slice(0, tried)
    for (const { old, next } of candidates) {
      // eslint-disable-next-line no-await-in-loop -- Newest first, the first that proves it.
      if (!(await within(root, head, next))) continue
      // eslint-disable-next-line no-await-in-loop -- As above.
      if (await within(root, head, old)) continue
      // eslint-disable-next-line no-await-in-loop -- As above.
      if (await within(root, head, `refs/heads/${local}`)) return true
    }
  }
  return false
}
