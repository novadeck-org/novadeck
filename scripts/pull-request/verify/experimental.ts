import { execFileSync } from "node:child_process"

import { excludedScopes } from "../../release-notes/commits.ts"
import {
  forEveryone,
  markersOf,
  scopesOf,
  type Experimental,
} from "../../release-notes/experimental.ts"
import type { Fetch } from "./commits.ts"

// The release notes leave out work on a feature still behind Preferences > Experimental
// (scripts/release-notes/experimental.json): by its commit scope, or by an `Experimental: <id>`
// line in the pull request's body. A pull request that changes a feature's own code under
// another scope has to say which it is, as nothing else tells the notes.

const told = new Set(["feat", "fix", "perf"])

/**
 * Why the pull request's body doesn't say enough about the Experimental features it changes:
 * an `Experimental:` line naming no listed feature, or a feat, fix or perf change to a listed
 * feature's code, under a scope of its own, without a line saying which it is.
 */
export const experimentalErrors = (
  title: string,
  body: string,
  files: readonly string[],
  experimental: Experimental,
): string[] => {
  const ids = [...experimental.keys()]
  const choices = `${ids.map((id) => `\`Experimental: ${id}\``).join(", ")} or \`Experimental: ${forEveryone}\``
  const markers = markersOf(body)
  const unknown = markers.filter((id) => id !== forEveryone && !experimental.has(id))
  if (unknown.length > 0)
    return [
      `\`Experimental: ${unknown.join("`, `Experimental: ")}\` names no feature still behind Experimental. Use ${choices}.`,
    ]
  const type = /^([a-z]+)/.exec(title.trim())?.[1] ?? ""
  const scopes = scopesOf(title)
  if (!told.has(type) || scopes.some((scope) => excludedScopes.has(scope)) || markers.length > 0)
    return []
  return [...experimental].flatMap(([id, feature]) => {
    if (scopes.some((scope) => feature.scopes.includes(scope))) return []
    const touched = files.filter((file) => feature.paths.some((path) => file.startsWith(path)))
    if (touched.length === 0) return []
    const shown = touched.slice(0, 3).join(", ") + (touched.length > 3 ? ", …" : "")
    return [
      `This changes ${id}'s own code (${shown}), which is still behind Preferences > Experimental. Add a line \`Experimental: ${id}\` to the description if only people with it turned on see the change (the release notes leave it out until it leaves Experimental), or \`Experimental: ${forEveryone}\` if everyone does.`,
    ]
  })
}

const gh: Fetch = (args) =>
  execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })

/** The paths a pull request changes, or none outside a pull request's run. */
export const pullRequestFiles = (
  env: Record<string, string | undefined>,
  fetch: Fetch = gh,
): string[] => {
  const number = env.PR_NUMBER
  const repository = env.GITHUB_REPOSITORY
  if (!number || !repository) {
    if (env.GITHUB_ACTIONS === "true")
      throw new Error("PR_NUMBER and GITHUB_REPOSITORY are required to read the changed files.")
    return []
  }
  return fetch([
    "api",
    "--paginate",
    `repos/${repository}/pulls/${number}/files`,
    "--jq",
    ".[].filename",
  ])
    .split("\n")
    .filter(Boolean)
}
