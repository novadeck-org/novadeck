import { createHmac } from "node:crypto"

/** What `hashPaths` needs to know of this machine. */
export type PathRule = {
  /** The person's home folder, written `~`. */
  readonly home?: string
  /** The person's account name, written `<user>` where it names a folder. */
  readonly user?: string
  /**
   * The app's own folders, by the name each is written as (`userData` becomes `<userData>`):
   * what is under them stays readable.
   */
  readonly places?: Readonly<Record<string, string>>
  /** Keys the hash, so a name can't be found by hashing likely ones; never logged. */
  readonly salt: string
}

// What a folder or file name may hold, as found in free text: no separator, space, quote,
// bracket, or `:`, which starts a stack frame's `:line:column`.
const name = String.raw`[^\s\\/"'\x60()<>\[\]{}|,;:*?]+`
// A name with spaces counts as one only where a separator follows it, as `My Project/` does.
const pathSegment = String.raw`(?:Program Files \(x86\)|${name}(?: (?!~)${name})+(?=[\\/])|${name})`
const separator = String.raw`[\\/]+`

/**
 * A path in free text: from a drive (`C:\`), a share (`\\server\`), home (`~/`), a
 * placeholder already written (`<userData>/`) or the root (`/`), or a `file://` address of
 * one; never in the middle of a word, nor an address of another kind (`https://host/a`).
 */
const pathPattern = new RegExp(
  String.raw`(?<![\w.~\-\\/<>#])(?!(?<=[A-Za-z][\w+.-]*:)//)(?<file>file://)?` +
    String.raw`(?<root>(?<=file://)/[A-Za-z]:(?=/)|[A-Za-z]:(?=[\\/])|\\\\(?=[^\\\s])|~(?=[\\/])|<[A-Za-z][\w-]*>(?=[\\/])|(?=/))` +
    String.raw`(?<rest>[\\/]*${pathSegment}(?:${separator}${pathSegment})*)`,
  "g",
)

// Where everything stays readable: the system's own folders.
const systemRoots = new Set([
  "usr",
  "opt",
  "proc",
  "sys",
  "dev",
  "bin",
  "sbin",
  "lib",
  "lib32",
  "lib64",
  "libx32",
  "etc",
  "nix",
  "snap",
  "run",
  "System",
  "Library",
  "Applications",
])
// Where only the first folder stays readable, as what is under it is anyone's.
const sharedRoots = new Set([
  "home",
  "Users",
  "tmp",
  "var",
  "private",
  "mnt",
  "media",
  "Volumes",
  "root",
  "srv",
])
const windowsSystemRoots = new Set([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
])
const windowsSharedRoots = new Set(["users"])
const wslShares = new Set(["wsl$", "wsl.localhost"])

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)

const windowsShaped = (path: string): boolean => /^(?:[A-Za-z]:|\\\\)/.test(path)

/** Finds `folder` in text, with either separator, and not as the start of a longer name. */
const folderPattern = (folder: string): RegExp => {
  // A leading separator is one, so `file:///home/ana` keeps its address's own two.
  const [first = "", ...rest] = folder.split(/[\\/]+/).map(escape)
  const body =
    first === "" ? String.raw`[\\/]${rest.join(separator)}` : [first, ...rest].join(separator)
  return new RegExp(String.raw`(?<![\w.\-~])${body}(?![\w.\-])`, windowsShaped(folder) ? "gi" : "g")
}

/**
 * Hashes the names in paths, so a log names no project, folder or file of the person's:
 * `/home/ana/acme/billing.ts` becomes `~/#1f2e3d4c/#9a8b7c6d.ts`. The same name hashes the
 * same wherever it appears on one install, as the hash is keyed with its salt, and a name
 * keeps its extension.
 *
 * Readable as they are: the app's own folders, written as their placeholders (`<userData>`),
 * and what is under them; the system's folders (`/usr`, `C:\Windows`, `/Applications`);
 * the first folder of a shared root (`/tmp`, `/home`, `C:\Users`); a WSL share and its
 * distribution; and everything inside `node_modules`. Home is written `~`, and a folder named
 * as the person's account `<user>`.
 */
export const hashPaths = (text: string, rule: PathRule): string => {
  const places = Object.entries(rule.places ?? {})
    .filter(([, folder]) => folder.length > 1)
    .toSorted(([, a], [, b]) => b.length - a.length)
  let result = text
  for (const [placeholder, folder] of places)
    result = result.replace(folderPattern(folder), `<${placeholder}>`)
  if (rule.home && rule.home.length > 1) result = result.replace(folderPattern(rule.home), "~")

  const user = rule.user?.toLowerCase()
  const hash = (segment: string, lower: boolean): string => {
    if (/^#[0-9a-f]{8}(?:\.|$)/.test(segment)) return segment
    if (user && segment.toLowerCase() === user) return "<user>"
    const dot = segment.lastIndexOf(".")
    const extension =
      dot > 0 && /^\.[A-Za-z0-9]{1,10}$/.test(segment.slice(dot)) ? segment.slice(dot) : ""
    const base = extension ? segment.slice(0, -extension.length) : segment
    const digest = createHmac("sha256", rule.salt)
      .update(lower ? base.toLowerCase() : base)
      .digest("hex")
    return `#${digest.slice(0, 8)}${extension}`
  }
  // Each name hashed from `from` on, but what is inside node_modules.
  const hashFrom = (segments: string[], from: number, lower: boolean): string[] => {
    const modules = segments.findIndex(
      (segment, index) => index >= from && segment === "node_modules",
    )
    return segments.map((segment, index) =>
      index < from || (modules !== -1 && index >= modules) ? segment : hash(segment, lower),
    )
  }
  const posix = (segments: string[], from: number): string[] => {
    const first = segments[from]
    if (first === undefined) return segments
    if (first === "mnt" && /^[a-z]$/i.test(segments[from + 1] ?? ""))
      return windows(segments, from + 2)
    if (systemRoots.has(first)) return segments
    return hashFrom(segments, sharedRoots.has(first) ? from + 1 : from, false)
  }
  const windows = (segments: string[], from: number): string[] => {
    const first = segments[from]?.toLowerCase()
    if (first === undefined) return segments
    if (windowsSystemRoots.has(first)) return segments
    return hashFrom(segments, windowsSharedRoots.has(first) ? from + 1 : from, true)
  }

  return result.replace(pathPattern, (match, ...args: unknown[]) => {
    const { file = "", root, rest } = args.at(-1) as { file?: string; root: string; rest: string }
    // Separators are kept as they were: the names sit between them.
    const parts = rest.split(/([\\/]+)/)
    const segments = parts.filter((_, index) => index % 2 === 0)
    const separators = parts.filter((_, index) => index % 2 === 1)
    const leading = segments[0] === "" ? 1 : 0
    const named = root.startsWith("<")
      ? segments
      : root === "~"
        ? hashFrom(segments, leading, false)
        : root === "\\\\"
          ? wslShares.has(segments[0]?.toLowerCase() ?? "")
            ? posix(segments, 2)
            : hashFrom(segments, 0, true)
          : root === ""
            ? posix(segments, leading)
            : windows(segments, leading)
    if (named === segments) return match
    return (
      file + root + named.flatMap((segment, index) => [segment, separators[index] ?? ""]).join("")
    )
  })
}
