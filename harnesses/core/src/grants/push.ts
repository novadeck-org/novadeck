// The `push` preset (Appendix A2): `git push [-u|--set-upstream] [-q] <remote> <src>:<dst>`.
import type { GitLookups, GrantRepo } from "../grants.js"
import { isBranchName } from "./refname.js"
import { normalizeRepoUrl, repoKey } from "./repo.js"

const lookupLimit = 1000
const remoteName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const options = new Set(["-u", "--set-upstream", "-q", "--no-follow-tags"])

const reservedDestination = (name: string, repos: readonly GrantRepo[]): boolean => {
  const lower = name.toLowerCase()
  return (
    ["main", "master", "head", "@"].includes(lower) ||
    name.startsWith("refs/") ||
    name.startsWith("heads/") ||
    name.startsWith("tags/") ||
    name.startsWith("remotes/") ||
    repos.some((repo) => repo.defaultBranch.toLowerCase() === lower)
  )
}

const granted = (key: string, repos: readonly GrantRepo[]): GrantRepo | undefined =>
  repos.find((repo) => repoKey(repo.url) === key)

// A lookup that throws or is slow is a lookup that found nothing.
const limited = async <T>(work: () => Promise<T>): Promise<T | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      work(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), lookupLimit)
      }),
    ])
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

// The granted repos a remote argument reaches: its own URL as git reads it (after the
// folder's `insteadOf` and `pushInsteadOf` rewrites), or every push URL of a named remote.
const reached = async (
  remote: string,
  repos: readonly GrantRepo[],
  git: GitLookups,
  where: string | null,
): Promise<readonly GrantRepo[] | undefined> => {
  if (where === null) return undefined
  if (normalizeRepoUrl(remote) !== undefined) {
    const url = await limited(() => git.pushTarget(where, remote))
    const key = url === undefined ? undefined : normalizeRepoUrl(url)?.toLowerCase()
    const repo = key === undefined ? undefined : granted(key, repos)
    return repo && [repo]
  }
  if (!remoteName.test(remote)) return undefined
  const urls = await limited(() => git.pushUrls(where, remote))
  if (urls === undefined || urls.length === 0) return undefined
  const found: GrantRepo[] = []
  for (const url of urls) {
    const key = normalizeRepoUrl(url)?.toLowerCase()
    const repo = key === undefined ? undefined : granted(key, repos)
    if (repo === undefined) return undefined
    found.push(repo)
  }
  return found
}

const heads = "refs/heads/"

/**
 * Whether the push's names are branches in `refs`, the folder git resolves them in. Git
 * takes a destination's namespace from its source, and a source that is a tag (`v1:v2`,
 * `tags/v1:v2`) creates a remote tag, which release workflows run on: so the source, `HEAD`
 * too (an agent can point it at a tag), must resolve to `refs/heads/…` here, and a
 * destination must not resolve to anything else (a tag of that name). Where git can't say,
 * they aren't.
 */
const branchesOnly = async (
  git: GitLookups,
  refs: string,
  source: string,
  destination: string,
): Promise<boolean> => {
  const from = await limited(() => git.resolve(refs, source))
  if (typeof from !== "string" || !from.startsWith(heads)) return false
  const to = await limited(() => git.resolve(refs, destination))
  return to === null || (typeof to === "string" && to.startsWith(heads))
}

/**
 * Whether `argv` is a push the preset allows to the granted `repos`: of branches only, in
 * `refs`, the folder git reads its names, remotes, URL rewrites and configuration in (the
 * call's own, else the session's or the terminal's; null when none is known).
 */
export const matchesPush = async (
  argv: readonly string[],
  repos: readonly GrantRepo[],
  git: GitLookups,
  refs: string | null,
): Promise<boolean> => {
  if (argv[0] !== "git" || argv[1] !== "push" || argv.length < 4) return false
  const flags = argv.slice(2, -2)
  if (!flags.every((flag) => options.has(flag)) || new Set(flags).size !== flags.length)
    return false
  const remote = argv[argv.length - 2] as string
  const refspec = argv[argv.length - 1] as string
  const colon = refspec.indexOf(":")
  if (colon < 0 || refspec.indexOf(":", colon + 1) >= 0) return false
  const source = refspec.slice(0, colon)
  const destination = refspec.slice(colon + 1)
  if (source.startsWith("+") || source.startsWith("refs/") || source.startsWith("heads/"))
    return false
  if (source !== "HEAD" && !isBranchName(source)) return false
  if (!isBranchName(destination)) return false
  // Everything below reads the folder's git: none known, nothing is certain.
  if (refs === null) return false
  // A push also sends the annotated tags its commits reach where `push.followTags` is on.
  if (!flags.includes("--no-follow-tags") && (await limited(() => git.followsTags(refs))) !== false)
    return false
  const targets = await reached(remote, repos, git, refs)
  if (targets === undefined) return false
  if (reservedDestination(destination, targets)) return false
  return branchesOnly(git, refs, source, destination)
}
