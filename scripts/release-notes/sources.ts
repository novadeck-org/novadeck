import { execFile } from "node:child_process"
import { promisify } from "node:util"

import { type RawCommit } from "./commits.ts"

const run = promisify(execFile)

/**
 * Everything the generator reads from outside, behind functions so tests run offline: git for
 * tags and commits, `gh` for releases (GH_TOKEN and GH_REPO come from the environment, as the
 * workflows set them).
 */
export type Sources = {
  /** Every `vX.Y.Z` tag reachable from `tag`, itself included, in any order. */
  readonly tags: (tag: string) => Promise<string[]>
  /** The commits in `from..to` (all of `to`'s history when `from` is `undefined`), oldest first. */
  readonly commits: (from: string | undefined, to: string) => Promise<RawCommit[]>
  /** A release's body and whether it is a prerelease, or `undefined` when the tag has no release. */
  readonly release: (tag: string) => Promise<{ body: string; prerelease: boolean } | undefined>
  /** The ref to name `tag` by in a link or range: its marker when it has one, else the tag. */
  readonly ref: (tag: string) => Promise<string>
  /** The tag of the latest stable release, or `undefined` before there is one. */
  readonly stable: () => Promise<string | undefined>
}

const fieldEnd = "\u001f"
const recordEnd = "\u001e"

/**
 * Where a `release-base/vX.Y.Z` tag stands in for `vX.Y.Z`. History was rewritten once (the
 * commit messages lost their AI co-author lines), so every `vX.Y.Z` made before then points at
 * a commit that main no longer holds, and GitHub's immutable releases keep those tags there.
 * A marker is a lightweight tag on the rewritten commit with the tree of the one its release
 * was built from. Wherever a tag has to be an ancestor of main (versions, notes ranges,
 * baselines), the marker counts as the tag. Only the newest release and the latest stable one
 * need a marker; once main holds a `vX.Y.Z` of its own, they are not read any more.
 */
export const markerPrefix = "release-base/"

/**
 * The ref to read `tag` from: its marker when it has one, else the tag itself. A marker only
 * exists for a tag that no longer is an ancestor of main, so there is nothing to choose between.
 */
export const refOf = async (tag: string, cwd?: string): Promise<string> => {
  try {
    await run("git", ["rev-parse", "--verify", "--quiet", `refs/tags/${markerPrefix}${tag}`], {
      cwd,
    })
    return `${markerPrefix}${tag}`
  } catch {
    return tag
  }
}

/**
 * The newest release reachable from HEAD, a real `vX.Y.Z` tag or a marker, as the tag it names
 * and the ref that holds it (the tag's own name, or the marker's), or `undefined` before there
 * is one. Old tags that stayed reachable (a rewrite keeps the commits before its first change)
 * can be older than a marker, so only the newest version says which one release-it must read.
 */
export const newestRelease = async (
  cwd?: string,
): Promise<{ tag: string; ref: string } | undefined> => {
  const { stdout } = await run(
    "git",
    ["tag", "--merged", "HEAD", "--list", "v*.*.*", `${markerPrefix}v*.*.*`],
    { cwd, maxBuffer: 16 * 1024 * 1024 },
  )
  const found = stdout
    .split("\n")
    .map((ref) => ({ ref, tag: ref.replace(markerPrefix, "") }))
    .flatMap(({ ref, tag }) => {
      const parts = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag)
      return parts ? [{ ref, tag, parts: parts.slice(1).map(Number) }] : []
    })
  found.sort((a, b) => a.parts.reduce((diff, part, at) => diff || part - b.parts[at]!, 0))
  const newest = found.at(-1)
  return newest && { tag: newest.tag, ref: newest.ref }
}

/** Git and `gh` as `Sources`, run in `cwd` (the current directory when `undefined`). */
export const makeGitSources = (cwd?: string): Sources => ({
  ref: (tag) => refOf(tag, cwd),
  tags: async (tag) => {
    const { stdout } = await run(
      "git",
      ["tag", "--merged", await refOf(tag, cwd), "--list", "v*.*.*", `${markerPrefix}v*.*.*`],
      { cwd, maxBuffer: 16 * 1024 * 1024 },
    )
    const names = stdout
      .split("\n")
      .filter(Boolean)
      .map((name) => name.replace(markerPrefix, ""))
    return [...new Set(names)]
  },
  commits: async (from, to) => {
    const { stdout } = await run(
      "git",
      [
        "log",
        "--reverse",
        `--format=%H${fieldEnd}%s${fieldEnd}%b${recordEnd}`,
        from ? `${await refOf(from, cwd)}..${to}` : to,
      ],
      { cwd, maxBuffer: 64 * 1024 * 1024 },
    )
    return stdout
      .split(recordEnd)
      .map((record) => record.replace(/^\n/, ""))
      .filter(Boolean)
      .map((record) => {
        const [sha = "", subject = "", body = ""] = record.split(fieldEnd)
        return { sha, subject, body }
      })
  },
  release: async (tag) => {
    try {
      const { stdout } = await run("gh", ["release", "view", tag, "--json", "body,isPrerelease"], {
        maxBuffer: 16 * 1024 * 1024,
      })
      const found = JSON.parse(stdout) as {
        body: string
        isPrerelease: boolean
      }
      return {
        body: found.body.replace(/\n$/, ""),
        prerelease: found.isPrerelease,
      }
    } catch (error) {
      // A tag without a release is the one failure that is an answer: `gh` says so on stderr.
      if (/release not found/i.test(String((error as { stderr?: string }).stderr))) return undefined
      throw error
    }
  },
  stable: async () => {
    try {
      const { stdout } = await run("gh", [
        "api",
        `repos/${process.env.GH_REPO ?? "{owner}/{repo}"}/releases/latest`,
        "--jq",
        ".tag_name",
      ])
      return stdout.trim() || undefined
    } catch (error) {
      // GitHub's latest release, which a repository without a stable one answers with a 404.
      if (/HTTP 404/.test(String((error as { stderr?: string }).stderr))) return undefined
      throw error
    }
  },
})

export const gitSources: Sources = makeGitSources()
