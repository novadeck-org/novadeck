import type { Remote } from "./forge.js"

const schemes = new Set(["http:", "https:", "ssh:", "git:", "git+ssh:", "ssh+git:"])

const scp = /^(?:([^@/\\\s]+)@)?([^:/\\\s]+):(?!\/\/)(.+)$/

// A host name as DNS has it: letters, digits and hyphens in dot-separated labels. Anything else
// (a space, `;`, `$`, a quote) is no forge's, and never reaches a command a shell runs.
const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const hostname = new RegExp(`^${label}(?:\\.${label})*$`)

/** Whether a host is a plain host name, safe to put in a command line. */
export const isHostname = (host: string): boolean => host.length <= 253 && hostname.test(host)

const segments = (path: string): string[] | undefined => {
  const parts = path.split("/").filter((part) => part !== "")
  const last = parts.at(-1)
  if (last === undefined) return undefined
  parts[parts.length - 1] = last.replace(/\.git$/, "")
  const decoded: string[] = []
  for (const part of parts) {
    try {
      decoded.push(decodeURIComponent(part))
    } catch {
      return undefined
    }
  }
  return decoded.length >= 2 && decoded.every((part) => part !== "") ? decoded : undefined
}

const remote = (host: string, path: string, user: string | undefined): Remote | undefined => {
  const parts = segments(path)
  const lower = host.toLowerCase()
  if (parts === undefined || !isHostname(lower)) return undefined
  return user === undefined || user === ""
    ? { host: lower, path: parts }
    : { host: lower, path: parts, user }
}

/** A git remote's URL (https, ssh, or scp form `user@host:path`) parsed; undefined for a local path or anything else. */
export const parseRemote = (url: string): Remote | undefined => {
  const text = url.trim()
  if (text === "") return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let parsed: URL
    try {
      parsed = new URL(text)
    } catch {
      return undefined
    }
    if (!schemes.has(parsed.protocol)) return undefined
    let user: string | undefined
    try {
      user = parsed.username === "" ? undefined : decodeURIComponent(parsed.username)
    } catch {
      user = undefined
    }
    return remote(parsed.hostname, parsed.pathname, user)
  }
  // Not a URL: `user@host:path`, unless it is a local path or a Windows drive.
  if (text.startsWith("/") || text.startsWith(".") || text.startsWith("~")) return undefined
  const match = scp.exec(text)
  if (match === null) return undefined
  const [, user, host, path] = match
  if (host === undefined || path === undefined || host.length < 2) return undefined
  return remote(host, path, user)
}
