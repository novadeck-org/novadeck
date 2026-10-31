import { execFile } from "node:child_process"
import { readdir, stat } from "node:fs/promises"
import { join, resolve } from "node:path"
import { promisify } from "node:util"

import { normalizeRepoUrl } from "@novadeck/harness-core/grants"
import { maxGrantRepos, type GrantRepoChoice } from "@novadeck/protocol"

const run = promisify(execFile)

/**
 * What the Grant card's repos are read from: the git repos under the project folder and
 * what GitHub says of them. An agent can `git init` a repo or add a remote before it
 * proposes, so a repo made or re-pointed lately is not ticked, nor is a remote that isn't
 * `origin`; the person ticks what they mean. This is the seam tests replace, so none runs git or gh.
 */
/** A default branch the protocol can carry (100 characters), else none: the guess stands in. */
const fitting = (branch: string | undefined): string | undefined =>
  branch !== undefined && branch.length <= 100 ? branch : undefined

export type GrantSources = {
  /** The GitHub repos of the git repos under `root`, two levels deep, as the card offers them. */
  repos(root: string): Promise<readonly GrantRepoChoice[]>
}

/** How far back a change to a repo's `.git/config` makes its origin unticked. */
export const recentMs = 24 * 60 * 60_000

/** What the reads need: injected by tests. */
export type SourceIo = {
  readonly now: () => number
  /** The subfolders of a folder, names only; none where it can't be read. */
  readonly folders: (dir: string) => Promise<readonly string[]>
  /** Whether the folder is a git repo or worktree: has a `.git`. */
  readonly isRepo: (dir: string) => Promise<boolean>
  /** Its remotes' names and URLs, from the repo's own config. */
  readonly remotes: (dir: string) => Promise<readonly { name: string; url: string }[]>
  /** When the repo's config last changed, in epoch milliseconds, or undefined. */
  readonly configChangedAt: (dir: string) => Promise<number | undefined>
  /** The default branch GitHub reports for `owner/name`, with a short timeout. */
  readonly githubDefault: (nameWithOwner: string) => Promise<string | undefined>
  /** The branch the remote's HEAD ref points at in the repo. */
  readonly remoteHead: (dir: string, remote: string) => Promise<string | undefined>
}

const gitMs = 2_000
const ghMs = 4_000
const maxFolders = 200
const depth = 2

const git = async (dir: string, args: readonly string[]): Promise<string | undefined> => {
  try {
    const { stdout } = await run("git", ["-C", dir, ...args], {
      timeout: gitMs,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    })
    return stdout.trim()
  } catch {
    return undefined
  }
}

/** The reads against the real disk, git and gh. */
export const systemIo: SourceIo = {
  now: Date.now,
  folders: async (dir) => {
    try {
      const names = await readdir(dir, { withFileTypes: true })
      return names
        .filter(
          (each) =>
            each.isDirectory() && !each.name.startsWith(".") && each.name !== "node_modules",
        )
        .map((each) => each.name)
        .toSorted()
    } catch {
      return []
    }
  },
  isRepo: async (dir) => {
    try {
      await stat(join(dir, ".git"))
      return true
    } catch {
      return false
    }
  },
  remotes: async (dir) => {
    const out = await git(dir, ["config", "--local", "--get-regexp", String.raw`^remote\..*\.url$`])
    return (out ?? "").split("\n").flatMap((line) => {
      const match = /^remote\.(.+)\.url (.+)$/.exec(line)
      return match ? [{ name: match[1]!, url: match[2]! }] : []
    })
  },
  configChangedAt: async (dir) => {
    const path = await git(dir, ["rev-parse", "--git-path", "config"])
    if (!path) return undefined
    try {
      // Git prints a path relative to the repo, or an absolute one (a linked worktree).
      return (await stat(resolve(dir, path))).mtimeMs
    } catch {
      return undefined
    }
  },
  githubDefault: async (nameWithOwner) => {
    try {
      const { stdout } = await run(
        "gh",
        ["repo", "view", nameWithOwner, "--json", "defaultBranchRef"],
        { timeout: ghMs, windowsHide: true },
      )
      const name = (JSON.parse(stdout) as { defaultBranchRef?: { name?: unknown } })
        .defaultBranchRef?.name
      return typeof name === "string" && name !== "" ? name : undefined
    } catch {
      return undefined
    }
  },
  remoteHead: async (dir, remote) => {
    const ref = await git(dir, ["symbolic-ref", "--short", `refs/remotes/${remote}/HEAD`])
    const prefix = `${remote}/`
    return ref?.startsWith(prefix) ? ref.slice(prefix.length) : undefined
  },
}

/** The repo choices of the git repos in `root` and two levels below it. */
export const findRepos = async (
  root: string,
  io: SourceIo = systemIo,
): Promise<readonly GrantRepoChoice[]> => {
  const dirs: string[] = []
  const walk = async (dir: string, level: number): Promise<void> => {
    if (dirs.length >= maxFolders) return
    if (await io.isRepo(dir)) dirs.push(dir)
    if (level >= depth) return
    for (const name of await io.folders(dir)) {
      if (dirs.length >= maxFolders) return
      // eslint-disable-next-line no-await-in-loop -- Read in order, bounded by `maxFolders`.
      await walk(join(dir, name), level + 1)
    }
  }
  await walk(root, 0)
  // One choice per repo URL: ticked if any folder has it as an old, unchanged origin.
  const found = new Map<
    string,
    { ticked: boolean; flag: GrantRepoChoice["flag"]; dir: string; remote: string }
  >()
  const now = io.now()
  for (const dir of dirs) {
    // eslint-disable-next-line no-await-in-loop -- Read in order.
    const [remotes, changed] = await Promise.all([io.remotes(dir), io.configChangedAt(dir)])
    const recent = changed === undefined || now - changed < recentMs
    for (const remote of remotes) {
      const url = normalizeRepoUrl(remote.url)
      // The protocol holds a repo's url to 160 characters (a grant must fit one delivery).
      if (url === undefined || url.length > 160) continue
      const isOrigin = remote.name === "origin"
      const flag: GrantRepoChoice["flag"] = !isOrigin ? "added-remote" : recent ? "recent" : null
      const earlier = found.get(url)
      if (earlier && (earlier.ticked || flag !== null)) continue
      found.set(url, { ticked: flag === null, flag, dir, remote: remote.name })
    }
  }
  const choices: GrantRepoChoice[] = []
  for (const [url, each] of [...found].slice(0, maxGrantRepos)) {
    // eslint-disable-next-line no-await-in-loop -- gh calls are few and bounded by their timeout.
    const fromGithub = fitting(await io.githubDefault(url.slice("github.com/".length)))
    // eslint-disable-next-line no-await-in-loop -- Read in order.
    const fromHead = fromGithub ? undefined : fitting(await io.remoteHead(each.dir, each.remote))
    choices.push({
      repo: {
        url,
        defaultBranch: fromGithub ?? fromHead ?? "main",
        defaultFrom: fromGithub ? "github" : fromHead ? "remote-head" : "guess",
      },
      ticked: each.ticked,
      flag: each.flag,
    })
  }
  return choices
}

/** The real sources. */
export const systemSources: GrantSources = { repos: (root) => findRepos(root) }
