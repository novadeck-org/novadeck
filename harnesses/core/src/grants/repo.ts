// GitHub repos by name: the URL forms a remote or `gh -R` may carry, as `github.com/owner/name`.

const owner = "[A-Za-z0-9][A-Za-z0-9-]*"
const name = "([A-Za-z0-9._-]+?)(?:\\.git)?"
const forms = [
  new RegExp(`^https://github\\.com/(${owner})/${name}$`),
  new RegExp(`^git@github\\.com:(${owner})/${name}$`),
  new RegExp(`^ssh://git@github\\.com/(${owner})/${name}$`),
]
const keyed = new RegExp(`^github\\.com/(${owner})/${name}$`)

const build = (match: RegExpMatchArray | null): string | undefined => {
  const [, user, repo] = match ?? []
  if (user === undefined || repo === undefined || repo === "." || repo === "..") return undefined
  return `github.com/${user}/${repo}`
}

/** `https://`, `git@github.com:` and `ssh://git@github.com/` forms as `github.com/o/n`. */
export const normalizeRepoUrl = (url: string): string | undefined => {
  for (const form of forms) {
    const found = build(url.match(form))
    if (found !== undefined) return found
  }
  return undefined
}

/** A granted repo's comparison key: a stored `github.com/o/n` or any URL form, lower-cased. */
export const repoKey = (url: string): string | undefined =>
  (normalizeRepoUrl(url) ?? build(url.match(keyed)))?.toLowerCase()

/** The key of a `gh -R` value: a URL form, `github.com/o/n` or `o/n`. */
export const ghRepoKey = (value: string): string | undefined =>
  repoKey(value) ?? repoKey(`github.com/${value}`)
