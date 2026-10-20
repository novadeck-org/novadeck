import { readFileSync } from "node:fs"
import { join } from "node:path"

import { type RawCommit } from "./commits.ts"
import { type Sources } from "./sources.ts"

// Real data: eighteen commits of this repository (git log's subjects and bodies, a body cut
// at 2,500 characters) chosen to hold the features the notes are for (#181, #188, #195, #330)
// and every kind the generator drops, and v0.0.152's body as GitHub holds it.
const here = join(import.meta.dirname, "fixtures")
export const commits: RawCommit[] = JSON.parse(readFileSync(join(here, "commits.json"), "utf8"))
export const releaseBody = readFileSync(join(here, "release-0.0.152.md"), "utf8").trimEnd()

export const commit = (pr: number): RawCommit => {
  const found = commits.find((raw) => raw.subject.endsWith(`(#${pr})`))
  if (!found) throw new Error(`No fixture commit for #${pr}`)
  return found
}

/** Sources over fixed tags, commits per range and bodies, with every call recorded. */
export const fakeSources = (options: {
  tags: string[]
  commits: Record<string, RawCommit[]>
  bodies?: Record<string, string>
  /** Tags whose releases are stable; the rest are prereleases. */
  stables?: string[]
  stable?: string | undefined
}): Sources & { readonly ranges: string[] } => {
  const ranges: string[] = []
  return {
    ranges,
    tags: async () => options.tags,
    commits: async (from, to) => {
      const range = `${from ?? ""}..${to}`
      ranges.push(range)
      return options.commits[range] ?? []
    },
    release: async (tag) => {
      const body = options.bodies?.[tag]
      return body === undefined ? undefined : { body, prerelease: !options.stables?.includes(tag) }
    },
    stable: async () => options.stable,
  }
}
