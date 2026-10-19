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
  /** The tag of the latest stable release, or `undefined` before there is one. */
  readonly stable: () => Promise<string | undefined>
}

const fieldEnd = "\u001f"
const recordEnd = "\u001e"

export const gitSources: Sources = {
  tags: async (tag) => {
    const { stdout } = await run("git", ["tag", "--merged", tag, "--list", "v*.*.*"], {
      maxBuffer: 16 * 1024 * 1024,
    })
    return stdout.split("\n").filter(Boolean)
  },
  commits: async (from, to) => {
    const { stdout } = await run(
      "git",
      [
        "log",
        "--reverse",
        `--format=%H${fieldEnd}%s${fieldEnd}%b${recordEnd}`,
        from ? `${from}..${to}` : to,
      ],
      { maxBuffer: 64 * 1024 * 1024 },
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
      const found = JSON.parse(stdout) as { body: string; isPrerelease: boolean }
      return { body: found.body.replace(/\n$/, ""), prerelease: found.isPrerelease }
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
}
