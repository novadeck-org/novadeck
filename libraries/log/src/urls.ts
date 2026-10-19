import { createHmac } from "node:crypto"

import { nameHasher, type PathRule } from "./paths.js"

/** What `hashUrls` keeps readable, besides what `hashPaths` needs. */
export type UrlRule = PathRule & {
  /**
   * Addresses that stay readable whole, by host (`novadeck.dev`), host and its subdomains
   * (`*.novadeck.dev`), or host and path (`github.com/novadeck-org`): the hosts the app
   * itself talks to.
   */
  readonly readableUrls?: readonly string[]
  /** Hosts written as they are, though their paths are hashed: public forges by default. */
  readonly publicHosts?: readonly string[]
}

/** Hosts many people use, named as they are: the forge of a failed clone says something. */
export const publicForges: readonly string[] = ["github.com", "gitlab.com", "bitbucket.org"]

// An address of any kind but `file://`, which `hashPaths` takes: scheme, user, host, port,
// path, query and fragment.
const urlPattern =
  /\b(?<scheme>(?!file:)[a-z][a-z0-9+.-]*):\/\/(?<user>[^\s/@'"]*@)?(?<host>\[[0-9a-f:]+\]|[^\s/:?#'"<>()[\]\\]+)(?<port>:\d+)?(?<path>\/[^\s?#'"<>()[\]\\]*)?(?<query>\?[^\s#'"()[\]\\]*)?(?<fragment>#[^\s'"()[\]\\]*)?/gi

// A Git remote over SSH, `git@github.com:acme/repo.git`: a path after the colon with a slash
// in it or a `.git` at its end.
const remotePattern =
  /(?<![\w.@-])(?<user>[\w.-]+)@(?<host>[\w-]+(?:\.[\w-]+)+):(?<path>(?=[^\s]*(?:\/|\.git\b))[\w.~-][\w./~-]*)/g

const loopback = /^(?:localhost|127(?:\.\d+){3}|\[::1\])$/i

// A host or address Node's network errors name bare: `getaddrinfo ENOTFOUND git.acme.corp`,
// `connect ECONNREFUSED 10.20.30.40:5432`.
const errorHostPattern =
  /\b(getaddrinfo (?:ENOTFOUND|EAI_AGAIN|EAI_FAIL)|(?:ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EADDRINUSE|EADDRNOTAVAIL)|Could not resolve host(?:name)?:?|connect to host) (\[[0-9a-f:]+\]|[\w-]+(?:\.[\w-]+)*)(:\d+)?/gi

// A repository on a public forge written without its scheme: `github.com/acme/repo`.
const forgePathPattern =
  /(?<![\w./:@-])(github\.com|gitlab\.com|bitbucket\.org)(\/[\w.-]+(?:\/[\w.-]+)?)/gi

// A file address with a host, as a share is written: `file://server/share/x`.
const fileHostPattern = /\bfile:\/\/(?!\/)([^\s/'"<>()]+)(\/[^\s'"<>()]*)?/gi

/**
 * Hashes what an address could say of the person: on hosts the app doesn't name, the host
 * (keeping its top-level domain: `git.acme.corp` becomes `#1a2b3c4d.corp`), the path's
 * names, and the query and fragment, which are dropped. Readable addresses (`readableUrls`)
 * stay whole; public forges and the loopback keep their host, their paths hashed. A
 * remote's user is kept only when it is `git`. A host Node's network errors name bare is
 * hashed as an address's is.
 */
export const hashUrls = (text: string, rule: UrlRule): string => {
  const hash = nameHasher(rule)
  const forges = new Set((rule.publicHosts ?? publicForges).map((host) => host.toLowerCase()))
  const readable = (rule.readableUrls ?? []).map((entry) => entry.toLowerCase())

  const isReadable = (host: string, path: string): boolean =>
    readable.some((entry) => {
      const [domain = "", ...prefix] = entry.split("/")
      const matches = domain.startsWith("*.")
        ? host === domain.slice(2) || host.endsWith(domain.slice(1))
        : host === domain
      if (!matches) return false
      if (prefix.length === 0) return true
      const under = `/${prefix.join("/")}`
      return path.toLowerCase() === under || path.toLowerCase().startsWith(`${under}/`)
    })

  const writeHost = (host: string): string => {
    const lower = host.toLowerCase()
    if (loopback.test(lower) || forges.has(lower)) return host
    const labels = lower.split(".")
    const top = labels.length > 1 && /^[a-z]{2,}$/.test(labels.at(-1) ?? "") ? labels.at(-1) : ""
    const digest = createHmac("sha256", rule.salt).update(lower).digest("hex").slice(0, 8)
    return top ? `#${digest}.${top}` : `#${digest}`
  }

  const writePath = (path: string): string =>
    path
      .split("/")
      .map((segment) => (segment === "" ? segment : hash(segment, false)))
      .join("/")

  const remotes = text.replace(remotePattern, (match, ...args: unknown[]) => {
    const { user, host, path } = args.at(-1) as { user: string; host: string; path: string }
    if (isReadable(host.toLowerCase(), `/${path}`)) return match
    const who = user === "git" ? user : "<redacted>"
    return `${who}@${writeHost(host)}:${writePath(path)}`
  })

  const hosts = remotes.replace(errorHostPattern, (match, code: string, host: string, port = "") =>
    isReadable(host.toLowerCase(), "") ? match : `${code} ${writeHost(host)}${port}`,
  )

  const bare = hosts
    .replace(forgePathPattern, (match, host: string, path: string) =>
      isReadable(host.toLowerCase(), path) ? match : `${host}${writePath(path)}`,
    )
    .replace(
      fileHostPattern,
      (match, host: string, path = "") => `file://${writeHost(host)}${writePath(path)}`,
    )

  return bare.replace(urlPattern, (match, ...args: unknown[]) => {
    const groups = args.at(-1) as Record<string, string | undefined>
    const { scheme = "", user = "", host = "", port = "" } = groups
    // Punctuation that ends a sentence ends the address.
    const tail = /[.,;:!?]+$/.exec(match)?.[0] ?? ""
    const strip = (part: string | undefined): string =>
      part && tail && match.endsWith(part) ? part.slice(0, -tail.length) : (part ?? "")
    const path = strip(groups.path)
    const query = strip(groups.query)
    const fragment = strip(groups.fragment)
    // A readable address keeps its path, not what it asked or pointed at; so does the
    // loopback's, which serves the app's own page and its scripts, as its stack frames name.
    if (isReadable(host.toLowerCase(), path) || loopback.test(host))
      return `${scheme}://${user}${host}${port}${path}${query ? "?…" : ""}${fragment ? "#…" : ""}${tail}`
    return (
      `${scheme}://${user}${writeHost(host)}${port}${writePath(path)}` +
      `${query ? "?…" : ""}${fragment ? "#…" : ""}${tail}`
    )
  })
}
