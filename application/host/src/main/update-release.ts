import { updateVersionPattern } from "@novadeck/protocol/bridge"

/** The GitHub repository releases are published to. */
export type ReleaseRepository = { readonly owner: string; readonly repo: string }

// GitHub's own rules for a user or organization name, and for a repository name.
const ownerPattern = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
const repoPattern = /^[A-Za-z0-9._-]{1,100}$/

const field = (text: string, name: string): string | undefined => {
  const match = new RegExp(`^${name}:[ \\t]*(.*?)[ \\t]*$`, "mu").exec(text)
  const value = match?.[1]?.replace(/^(["'])(.*)\1$/u, "$2")
  return value === "" ? undefined : value
}

/**
 * The repository the build updates from, read from `resources/app-update.yml`, which
 * electron-builder writes from its `publish` block. Undefined unless the file names the
 * GitHub provider and an owner and repository GitHub could have: the address built
 * from them is opened in the browser, so nothing else gets through.
 */
export const releaseRepositoryOf = (yaml: string): ReleaseRepository | undefined => {
  const owner = field(yaml, "owner")
  const repo = field(yaml, "repo")
  if (field(yaml, "provider") !== "github") return undefined
  if (owner === undefined || !ownerPattern.test(owner)) return undefined
  if (repo === undefined || !repoPattern.test(repo) || repo === "." || repo === "..")
    return undefined
  return { owner, repo }
}

/**
 * The page of a version's release, where its notes and downloads are, or undefined for
 * a version that is not a release's.
 */
export const releasePageUrl = (
  { owner, repo }: ReleaseRepository,
  version: string,
): string | undefined =>
  updateVersionPattern.test(version)
    ? `https://github.com/${owner}/${repo}/releases/tag/v${version}`
    : undefined

/**
 * The address, ending in "/", that a version's release assets are downloaded from, or
 * undefined for a version that is not a release's.
 */
export const releaseDownloadsUrl = (
  { owner, repo }: ReleaseRepository,
  version: string,
): string | undefined =>
  updateVersionPattern.test(version)
    ? `https://github.com/${owner}/${repo}/releases/download/v${version}/`
    : undefined
