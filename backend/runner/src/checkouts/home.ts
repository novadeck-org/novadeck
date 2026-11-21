import { stat } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { git, type Run } from "./git.js"
import { branchAt, commonDir, mainBranch, type Main } from "./repository.js"

// What Novadeck keeps in git about a tracked worktree's branch, in the repository's own config
// (`.git/config`, which all its worktrees share, and which is never committed or pushed):
// - `branch.<b>.novadeckHome`, the branch its work belongs on, where that isn't the repository's
//   main (a worktree opened with `home`, or `from` a branch, as `JIRA-123`);
// - `branch.<b>.novadeckBase`, the commit it started from;
// - `branch.<b>.novadeckMade`, whether Novadeck made the branch.
// Git moves them with a renamed branch and drops them with a deleted one, and plain `git config`
// reads them in any harness or script. Only the runner writes them: an agent's sandbox may hold
// `.git` read-only. See architecture/worktree-home.md in the workspace.

/** The keys of one branch, as read. */
export type BranchKeys = {
  readonly home?: string
  readonly base?: string
  readonly made?: boolean
}

/** The keys' names as written; git compares variable names without case. */
const names = { home: "novadeckHome", base: "novadeckBase", made: "novadeckMade" } as const

const small = { cap: 256 * 1024 }

/** What git means by true, for a boolean it reads. */
const truthy = (value: string): boolean => ["true", "yes", "on", "1", ""].includes(value)

/**
 * Every branch's keys in `git config -z --get-regexp` output (`key\nvalue\0`, or `key\0` for a
 * key with no value): the branch is the key between `branch.` and its last dot, as a branch name
 * may hold dots and git prints the variable lowercased.
 */
export const parseKeys = (out: string): ReadonlyMap<string, BranchKeys> => {
  const found = new Map<string, { home?: string; base?: string; made?: boolean }>()
  for (const entry of out.split("\0")) {
    if (entry === "") continue
    const at = entry.indexOf("\n")
    const key = at === -1 ? entry : entry.slice(0, at)
    const value = at === -1 ? "" : entry.slice(at + 1)
    const dot = key.lastIndexOf(".")
    if (!key.startsWith("branch.") || dot <= "branch.".length) continue
    const branch = key.slice("branch.".length, dot)
    const variable = key.slice(dot + 1).toLowerCase()
    const keys = found.get(branch) ?? {}
    if (variable === names.home.toLowerCase() && value !== "") keys.home = value
    else if (variable === names.base.toLowerCase() && value !== "") keys.base = value
    else if (variable === names.made.toLowerCase()) keys.made = truthy(value.toLowerCase())
    else continue
    found.set(branch, keys)
  }
  return found
}

/** Each repository's keys as last read, by its common dir, with the config file's stamp. */
const read = new Map<
  string,
  { readonly stamp: string; readonly keys: ReadonlyMap<string, BranchKeys> }
>()

/** The config file's modification time and size: a write moves at least one. */
const stampOf = async (common: string): Promise<string | undefined> => {
  const info = await stat(join(common, "config")).catch(() => undefined)
  return info ? `${info.mtimeMs}:${info.size}` : undefined
}

/**
 * Every branch's keys in the repository `folder` is in, read once for each change to its config
 * file; empty where it has none, or git couldn't read them (which is tried again next time).
 */
export const keysOf = async (folder: string): Promise<ReadonlyMap<string, BranchKeys>> => {
  const common = await commonDir(folder)
  if (common === undefined) return new Map()
  const stamp = await stampOf(common)
  const known = read.get(common)
  if (stamp !== undefined && known?.stamp === stamp) return known.keys
  const run = await git(
    folder,
    ["config", "-z", "--local", "--get-regexp", String.raw`^branch\..*\.novadeck`],
    small,
  )
  // Exit 1: no key matched, which is an answer.
  if (!run.ok && !(run.kind === "exit" && run.status === 1)) return new Map()
  const keys = run.ok ? parseKeys(run.out) : new Map<string, BranchKeys>()
  if (stamp !== undefined) read.set(common, { stamp, keys })
  return keys
}

/** One branch's keys; none where it has none. */
export const keysOfBranch = async (folder: string, branch: string): Promise<BranchKeys> =>
  (await keysOf(folder)).get(branch) ?? {}

/** Whether a failed config write was another writer holding `config.lock`, worth a retry. */
const locked = (run: Run): boolean => !run.ok && run.kind === "exit" && /lock/i.test(run.said ?? "")

/** How long to wait before each retry of a write that met the lock. */
const retriesMs = [50, 150, 400]

/**
 * Sets one branch's keys, each given one (`null` unsets it), in the repository `folder` is in.
 * Retried a few times while another writer holds the config's lock; false where a write still
 * failed, which the caller logs and lives with: nothing Novadeck does depends on a key alone.
 */
export const writeKeys = async (
  folder: string,
  branch: string,
  keys: { readonly home?: string | null; readonly base?: string | null; readonly made?: boolean },
): Promise<boolean> => {
  let ok = true
  for (const [field, value] of Object.entries(keys) as [keyof typeof names, unknown][]) {
    if (value === undefined) continue
    const key = `branch.${branch}.${names[field]}`
    const args =
      value === null
        ? ["config", "--local", "--unset-all", key]
        : ["config", "--local", key, String(value)]
    // eslint-disable-next-line no-await-in-loop -- One key at a time, in one config file.
    let run = await git(folder, args, small)
    for (const ms of retriesMs) {
      if (!locked(run)) break
      // eslint-disable-next-line no-await-in-loop -- Waiting out another writer, then again.
      await sleep(ms)
      // eslint-disable-next-line no-await-in-loop -- As above.
      run = await git(folder, args, small)
    }
    // Exit 5: unsetting a key that isn't there, which leaves it as asked.
    if (!run.ok && !(value === null && run.kind === "exit" && run.status === 5)) ok = false
  }
  // Read again next time, whatever the file's times say (a coarse clock may not move them).
  const common = await commonDir(folder)
  if (common !== undefined) read.delete(common)
  return ok
}

/**
 * What a checkout's work is measured against: `main`, the branch its files are compared with,
 * and `holders`, every branch whose holding its work makes the work home (merged, and safe to
 * close): home, home's remote-tracking branch and the repository's main, always, so work that
 * reached main another way (a stacked pull request retargeted to main) is home too. `home` is
 * home's name where the branch's key names one that is there; `base` the commit the branch's key
 * says it started from.
 */
export type Target = {
  readonly main: Main
  readonly holders: readonly Main[]
  readonly home?: string
  readonly base?: string
}

/** Whether `a` is `b` or an ancestor of it. */
const within = async (folder: string, a: string, b: string): Promise<boolean> =>
  (await git(folder, ["merge-base", "--is-ancestor", a, b], small)).ok

/** A local branch's remote-tracking branch: its upstream, else origin's of that name. */
const upstreamOf = async (folder: string, branch: string): Promise<Main | undefined> => {
  const set = await git(
    folder,
    ["for-each-ref", "--format=%(upstream)", "--", `refs/heads/${branch}`],
    small,
  )
  const named = set.ok ? set.out.trim() : ""
  return branchAt(
    folder,
    named.startsWith("refs/remotes/") ? named : `refs/remotes/origin/${branch}`,
  )
}

/**
 * Home as a work is measured against it: its remote-tracking branch where that holds local home
 * (or there is no local one), else local home; with both as holders. Undefined where neither is
 * there (home was deleted).
 */
const homeAt = async (
  folder: string,
  home: string,
): Promise<{ readonly measure: Main; readonly holders: readonly Main[] } | undefined> => {
  const local = await branchAt(folder, `refs/heads/${home}`)
  const remote = await upstreamOf(folder, home)
  if (!local && !remote) return undefined
  const holders = [local, remote].filter((each): each is Main => each !== undefined)
  if (!local) return { measure: remote!, holders }
  if (!remote) return { measure: local, holders }
  const measure = (await within(folder, local.commit, remote.commit)) ? remote : local
  return { measure, holders }
}

/**
 * What the checkout at `folder`, on `branch` (null when detached), is measured against: the
 * repository's main as ever where its branch has no home key, or home is gone; else home, with
 * main among the holders. Undefined where there is nothing to measure by (no main, no home).
 */
export const targetOf = async (
  folder: string,
  branch: string | null,
): Promise<Target | undefined> => {
  const main = await mainBranch(folder)
  const keys = branch === null ? {} : await keysOfBranch(folder, branch)
  const base = keys.base === undefined ? {} : { base: keys.base }
  const home = keys.home === undefined ? undefined : await homeAt(folder, keys.home)
  if (!home) return main ? { main, holders: [main], ...base } : undefined
  const holders = [...home.holders]
  if (main && !holders.some((each) => each.commit === main.commit && each.name === main.name))
    holders.push(main)
  return { main: home.measure, holders, home: keys.home!, ...base }
}

/** The branch a checkout is on, by its short name; undefined when detached or unreadable. */
export const currentBranch = async (folder: string): Promise<string | undefined> => {
  const run = await git(folder, ["symbolic-ref", "-q", "--short", "HEAD"], small)
  return run.ok ? run.out.trim() || undefined : undefined
}
