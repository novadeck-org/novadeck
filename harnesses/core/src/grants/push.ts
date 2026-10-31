// The `push` preset (Appendix A2): `git push [-u|--set-upstream] [-q] <remote> <src>:<dst>`.
import type { GitLookups, GrantRepo } from "../grants.js"
import { isBranchName } from "./refname.js"
import { normalizeRepoUrl, repoKey } from "./repo.js"

const lookupLimit = 1000
const remoteName = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const options = new Set(["-u", "--set-upstream", "-q"])

const reservedDestination = (name: string, repos: readonly GrantRepo[]): boolean => {
  const lower = name.toLowerCase()
  return (
    ["main", "master", "head", "@"].includes(lower) ||
    name.startsWith("refs/") ||
    name.startsWith("heads/") ||
    repos.some((repo) => repo.defaultBranch.toLowerCase() === lower)
  )
}

const granted = (key: string, repos: readonly GrantRepo[]): GrantRepo | undefined =>
  repos.find((repo) => repoKey(repo.url) === key)

// A lookup that throws or is slow is a lookup that found nothing.
const lookup = async (
  git: GitLookups,
  cwd: string,
  remote: string,
): Promise<readonly string[] | undefined> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      git.pushUrls(cwd, remote),
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

// The granted repos a remote argument reaches: its own URL, or every push URL of a named remote.
const reached = async (
  remote: string,
  repos: readonly GrantRepo[],
  git: GitLookups,
  cwd: string | null,
): Promise<readonly GrantRepo[] | undefined> => {
  const own = normalizeRepoUrl(remote)
  if (own !== undefined) {
    const repo = granted(own.toLowerCase(), repos)
    return repo && [repo]
  }
  if (cwd === null || !remoteName.test(remote)) return undefined
  const urls = await lookup(git, cwd, remote)
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

/** Whether `argv` is a push the preset allows to the granted `repos`. */
export const matchesPush = async (
  argv: readonly string[],
  repos: readonly GrantRepo[],
  git: GitLookups,
  cwd: string | null,
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
  const targets = await reached(remote, repos, git, cwd)
  if (targets === undefined) return false
  return !reservedDestination(destination, targets)
}
